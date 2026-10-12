import { expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { lookupNetworkHost } from "../src/egress/workspace-dns.ts";
import type { WorkspaceNetworkPolicy } from "@kintsugi/shared/network-policy";

test("proxy DNS sends .local and LAN search queries only to the configured external forwarder", async () => {
  const server = createSocket("udp4");
  const names: string[] = [];
  server.on("message", (query, remote) => {
    const labels: string[] = [];
    let offset = 12;
    while (query[offset]) { const length = query[offset++]!; labels.push(query.subarray(offset, offset + length).toString()); offset += length; }
    offset++;
    const name = labels.join(".");
    names.push(name);
    const qtype = query.readUInt16BE(offset);
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(name === "broken.local" ? 0x8182 : 0x8180, 2);
    header.writeUInt16BE(qtype === 1 && name !== "broken.local" ? 1 : 0, 6);
    header.writeUInt32BE(0, 8);
    const answer = qtype === 1 && name !== "broken.local" ? Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 10, 0, 4, 192, 168, 10, 20]) : Buffer.alloc(0);
    server.send(Buffer.concat([header, query.subarray(12, offset + 4), answer]), remote.port, remote.address);
  });
  await new Promise<void>(resolve => server.bind(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const policy: WorkspaceNetworkPolicy = { mode: "lan", cidrs: ["192.168.10.0/24"], dns: [`127.0.0.1:${address.port}`], search: ["home.arpa"], denied: [] };
    expect(await lookupNetworkHost("printer.local", policy)).toEqual([{ address: "192.168.10.20", family: 4 }]);
    expect(await lookupNetworkHost("nas", policy)).toEqual([{ address: "192.168.10.20", family: 4 }]);
    expect(names).toContain("printer.local");
    expect(names).toContain("nas.home.arpa");
    expect(names).not.toContain("nas");
    const count = names.length;
    expect(await lookupNetworkHost("192.168.10.21", policy)).toEqual([{ address: "192.168.10.21", family: 4 }]);
    expect(names.length).toBe(count);
    await expect(lookupNetworkHost("broken.local", policy)).rejects.toThrow();
  } finally { server.close(); }
});

test("a configured forwarder cannot bypass control or peer-workspace isolation", async () => {
  const policy: WorkspaceNetworkPolicy = { mode: "private", cidrs: ["192.168.0.0/16"], dns: ["192.168.10.53"], search: [], denied: ["192.168.10.0/24"] };
  await expect(lookupNetworkHost("printer.local", policy)).rejects.toThrow("DNS forwarder cannot be a Kintsugi control or workspace address");
});

interface DnsReply { code?: number; address?: string }
async function withForwarders(replies: Array<(name: string, type: number) => DnsReply>, run: (policy: WorkspaceNetworkPolicy, queries: Array<{ server: number; name: string; type: number }>) => Promise<void>) {
  const servers = replies.map(() => createSocket("udp4"));
  const queries: Array<{ server: number; name: string; type: number }> = [];
  try {
    for (const [index, server] of servers.entries()) {
      server.on("message", (query, remote) => {
        const labels: string[] = [];
        let offset = 12;
        while (query[offset]) { const length = query[offset++]!; labels.push(query.subarray(offset, offset + length).toString()); offset += length; }
        offset++;
        const name = labels.join(".");
        const type = query.readUInt16BE(offset);
        queries.push({ server: index, name, type });
        const reply = replies[index]!(name, type);
        const header = Buffer.from(query.subarray(0, 12));
        const answer = type === 1 && reply.address ? Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 10, 0, 4, ...reply.address.split(".").map(Number)]) : Buffer.alloc(0);
        header.writeUInt16BE(0x8180 | (reply.code ?? 0), 2);
        header.writeUInt16BE(answer.length ? 1 : 0, 6);
        header.writeUInt32BE(0, 8);
        server.send(Buffer.concat([header, query.subarray(12, offset + 4), answer]), remote.port, remote.address);
      });
      await new Promise<void>(resolve => server.bind(0, "127.0.0.1", resolve));
    }
    const policy: WorkspaceNetworkPolicy = { mode: "lan", cidrs: ["192.168.10.0/24"], dns: servers.map(server => `127.0.0.1:${server.address().port}`), search: [], denied: [] };
    await run(policy, queries);
  } finally { for (const server of servers) server.close(); }
}

test("proxy DNS retries the next configured forwarder after NXDOMAIN or no records", async () => {
  for (const code of [3, 0]) await withForwarders([() => ({ code }), () => ({ address: "192.168.10.20" })], async (policy, queries) => {
    expect(await lookupNetworkHost("printer.local", policy)).toEqual([{ address: "192.168.10.20", family: 4 }]);
    expect(queries.some(query => query.server === 0)).toBe(true);
    expect(queries.some(query => query.server === 1 && query.name === "printer.local")).toBe(true);
  });
});

test("proxy DNS stops at a positive answer when the other family has no records", () => withForwarders([() => ({ address: "192.168.10.20" }), () => ({ address: "192.168.10.21" })], async (policy, queries) => {
  expect(await lookupNetworkHost("printer.local", policy)).toEqual([{ address: "192.168.10.20", family: 4 }]);
  expect(queries.some(query => query.server === 1)).toBe(false);
}));

test("proxy DNS exhausts configured forwarders for a search candidate before the bare name", () => withForwarders([name => name === "nas" ? { address: "192.168.10.21" } : { code: 3 }, () => ({ address: "192.168.10.20" })], async (policy, queries) => {
  policy.search = ["home.arpa"];
  expect(await lookupNetworkHost("nas", policy)).toEqual([{ address: "192.168.10.20", family: 4 }]);
  expect(queries.some(query => query.name === "nas")).toBe(false);
  expect(queries.some(query => query.server === 1 && query.name === "nas.home.arpa")).toBe(true);
}));

test("proxy DNS retries expected server failures but rejects when every forwarder fails", async () => {
  for (const code of [2, 5]) await withForwarders([() => ({ code }), () => ({ address: "192.168.10.20" })], async policy => {
    expect(await lookupNetworkHost("printer.local", policy)).toEqual([{ address: "192.168.10.20", family: 4 }]);
  });
  await withForwarders([() => ({ code: 2 }), () => ({ code: 3 })], async policy => {
    await expect(lookupNetworkHost("printer.local", policy)).rejects.toMatchObject({ code: "ESERVFAIL" });
  });
  await withForwarders([() => ({ code: 3 }), () => ({ code: 3 })], async policy => {
    await expect(lookupNetworkHost("printer.local", policy)).rejects.toMatchObject({ code: "ENOTFOUND" });
  });
});

test("proxy DNS validates every fallback forwarder before making any query", () => withForwarders([() => ({ address: "192.168.10.20" })], async (policy, queries) => {
  policy.dns.push("192.168.10.53");
  policy.denied = ["192.168.10.0/24"];
  await expect(lookupNetworkHost("printer.local", policy)).rejects.toThrow("DNS forwarder cannot be a Kintsugi control or workspace address");
  expect(queries).toEqual([]);
}));

test("proxy DNS retries the whole name rather than masking a server failure in one family", () => withForwarders([(_name, type) => type === 1 ? { address: "192.168.10.20" } : { code: 2 }, () => ({ address: "192.168.10.21" })], async policy => {
  expect(await lookupNetworkHost("printer.local", policy)).toEqual([{ address: "192.168.10.21", family: 4 }]);
}));

test("proxy DNS propagates unexpected protocol errors without consulting another forwarder", () => withForwarders([() => ({ code: 1 }), () => ({ address: "192.168.10.20" })], async (policy, queries) => {
  await expect(lookupNetworkHost("printer.local", policy)).rejects.toMatchObject({ code: "EFORMERR" });
  expect(queries.some(query => query.server === 1)).toBe(false);
}));
