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
