import { expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import dns from "node:dns/promises";
import { forwardDns, startDnsForwarder as bindDnsForwarder } from "./dns-forwarder.ts";
import { assignWorkspaceResolvers } from "./workspace-resolver.ts";
import { offNetworkPolicy, parseNetworkPolicy, networkResolvConf, type WorkspaceNetworkPolicy } from "../../../packages/shared/src/network-policy.ts";

// TCP and UDP have independent ephemeral-port pools. Retry only setup collisions,
// never resolver work or assertions; System’s fixed production port is unchanged.
async function retryDnsBind<T>(bind: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await bind(); }
    catch (error) {
      if (attempt === 7 || !(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    }
  }
}
const startDnsForwarder = (...args: Parameters<typeof bindDnsForwarder>) => retryDnsBind(() => bindDnsForwarder(...args));

function query(type = 1) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1234);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, Buffer.from([7]), Buffer.from("printer"), Buffer.from([5]), Buffer.from("local"), Buffer.from([0, 0, type, 0, 1])]);
}
function reply(request: Buffer, code = 0, data?: Buffer, truncated = false) {
  const header = Buffer.from(request.subarray(0, 12));
  header.writeUInt16BE(0x8180 | code | (truncated ? 0x0200 : 0), 2);
  header.writeUInt16BE(data ? 1 : 0, 6);
  const record = Buffer.from([0xc0, 12, ...request.subarray(request.length - 4), 0, 0, 0, 60, 0, 0]);
  record.writeUInt16BE(data?.length ?? 0, 10);
  return Buffer.concat([header, request.subarray(12), ...(data ? [record, data] : [])]);
}
async function bindFixture(answer: (request: Buffer, tcp: boolean) => Buffer | undefined, address = "127.0.0.1") {
  const udp = createSocket(address.includes(":") ? "udp6" : "udp4");
  const requests: Array<{ tcp: boolean; request: Buffer }> = [];
  udp.on("message", (request, remote) => {
    requests.push({ tcp: false, request });
    const response = answer(request, false);
    if (response) udp.send(response, remote.port, remote.address);
  });
  await new Promise<void>(resolve => udp.bind(0, address, resolve));
  const tcp = createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2 || buffer.length < buffer.readUInt16BE(0) + 2) return;
      const request = buffer.subarray(2, buffer.readUInt16BE(0) + 2);
      requests.push({ tcp: true, request });
      const response = answer(request, true);
      if (response) {
        const frame = Buffer.alloc(response.length + 2);
        frame.writeUInt16BE(response.length);
        response.copy(frame, 2);
        socket.end(frame);
      }
    });
  });
  const port = udp.address().port;
  try {
    await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, address, () => { tcp.removeListener("error", reject); resolve(); }); });
  } catch (error) { await new Promise<void>(resolve => udp.close(() => resolve())); throw error; }
  return { upstream: { address, port }, requests, close: async () => {
    await Promise.all([new Promise<void>(resolve => udp.close(() => resolve())), new Promise<void>(resolve => tcp.close(() => resolve()))]);
  } };
}

const fixture = (...args: Parameters<typeof bindFixture>) => retryDnsBind(() => bindFixture(...args));

test("DNS fixture setup retries only address collisions and never suppresses other failures", async () => {
  let attempts = 0;
  expect(await retryDnsBind(async () => { if (++attempts < 3) throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" }); return "bound"; })).toBe("bound");
  expect(attempts).toBe(3);
  await expect(retryDnsBind(async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); })).rejects.toThrow("permission denied");
  let collisions = 0;
  await expect(retryDnsBind(async () => { collisions++; throw Object.assign(new Error("still occupied"), { code: "EADDRINUSE" }); })).rejects.toThrow("still occupied");
  expect(collisions).toBe(8);
});

test("System DNS retries negative answers and operational failures in order, preserving the wire reply", async () => {
  for (const code of [0, 2, 3, 5]) {
    const first = await fixture(request => reply(request, code));
    const second = await fixture(request => reply(request, 0, Buffer.from([192, 168, 10, 20])));
    try {
      const response = await forwardDns(query(), [first.upstream, second.upstream]);
      expect(response).toEqual(reply(query(), 0, Buffer.from([192, 168, 10, 20])));
      expect(first.requests.length).toBe(1);
      expect(second.requests.length).toBe(1);
    } finally { await first.close(); await second.close(); }
  }
});

test("System DNS preserves TXT records for native clients and does not consult later servers after success", async () => {
  const first = await fixture(request => reply(request, 0, Buffer.from([5, ...Buffer.from("hello")])));
  const second = await fixture(request => reply(request, 3));
  const server = await startDnsForwarder("127.0.0.1", () => [first.upstream, second.upstream], 0);
  try {
    const resolver = new dns.Resolver();
    resolver.setServers([`127.0.0.1:${server.port}`]);
    expect(await resolver.resolveTxt("printer.local")).toEqual([["hello"]]);
    expect(second.requests).toEqual([]);
  } finally { await server.close(); await first.close(); await second.close(); }
});

test("System DNS handles TCP clients and upgrades truncated upstream UDP replies to TCP", async () => {
  const upstream = await fixture((request, tcp) => tcp ? reply(request, 0, Buffer.from([192, 168, 10, 20])) : reply(request, 0, undefined, true));
  const server = await startDnsForwarder("127.0.0.1", () => [upstream.upstream], 0);
  try {
    const resolver = new dns.Resolver();
    resolver.setServers([`127.0.0.1:${server.port}`]);
    expect(await resolver.resolve4("printer.local")).toEqual(["192.168.10.20"]);
    expect(upstream.requests.map(request => request.tcp)).toEqual([false, true]);
    expect(await forwardDns(query(), [{ address: "127.0.0.1", port: server.port }], true)).toEqual(reply(query(), 0, Buffer.from([192, 168, 10, 20])));
  } finally { await server.close(); await upstream.close(); }
});

test("System DNS bounds timeout retries and fails closed with no configured upstream", async () => {
  const silent = await fixture(() => undefined);
  const working = await fixture(request => reply(request, 0, Buffer.from([192, 168, 10, 20])));
  try {
    expect(await forwardDns(query(), [silent.upstream, working.upstream], false, 20)).toEqual(reply(query(), 0, Buffer.from([192, 168, 10, 20])));
    expect((await forwardDns(query(), [])).readUInt16BE(2) & 15).toBe(2);
    expect((await forwardDns(Buffer.from([0, 1]), [])).readUInt16BE(2) & 15).toBe(1);
  } finally { await silent.close(); await working.close(); }
});

test("System DNS returns absence after all negative answers and exposes protocol errors without fallback", async () => {
  const missing = await fixture(request => reply(request, 3));
  const invalid = await fixture(request => reply(request, 1));
  try {
    expect((await forwardDns(query(), [missing.upstream])).readUInt16BE(2) & 15).toBe(3);
    expect((await forwardDns(query(), [invalid.upstream, missing.upstream])).readUInt16BE(2) & 15).toBe(1);
    expect(missing.requests.length).toBe(1);
  } finally { await missing.close(); await invalid.close(); }
});

test("workspace resolver views are opt-in, unique, stable and removed by Off or empty upstreams", () => {
  const enabled: WorkspaceNetworkPolicy = { mode: "lan", cidrs: ["192.168.10.0/24"], dns: ["192.168.10.53"], search: [], denied: [] };
  expect(assignWorkspaceResolvers({})).toEqual({});
  const initial = assignWorkspaceResolvers({ off: offNetworkPolicy(), a: enabled, b: enabled, empty: { ...enabled, dns: [] } });
  expect(initial.off!.resolver).toBeUndefined();
  expect(initial.empty!.resolver).toBeUndefined();
  expect(initial.a!.resolver).toBe("198.18.0.1");
  expect(initial.b!.resolver).toBe("198.18.0.2");
  expect(assignWorkspaceResolvers(initial)).toEqual(initial);
  expect(networkResolvConf(initial.a!)).toBe("nameserver 198.18.0.1\n");
  expect(assignWorkspaceResolvers({ a: offNetworkPolicy(), b: initial.b! }).a!.resolver).toBeUndefined();
  expect(() => assignWorkspaceResolvers({ a: initial.a!, b: initial.a! })).toThrow("Duplicate workspace resolver address");
  expect(() => parseNetworkPolicy({ ...enabled, resolver: "192.168.10.53" })).toThrow();
});

test("System DNS forwards IPv6 upstreams and AAAA records through its IPv4 workspace view", async () => {
  const upstream = await fixture(request => reply(request, 0, Buffer.from("fd120000000000000000000000000020", "hex")), "::1");
  const server = await startDnsForwarder("127.0.0.1", () => [upstream.upstream], 0);
  try {
    const resolver = new dns.Resolver();
    resolver.setServers([`127.0.0.1:${server.port}`]);
    expect(await resolver.resolve6("printer.local")).toEqual(["fd12::20"]);
  } finally { await server.close(); await upstream.close(); }
});

test("System DNS truncates large UDP answers so native clients retry over TCP", async () => {
  const data = Buffer.concat([Buffer.from([250]), Buffer.alloc(250, 97), Buffer.from([250]), Buffer.alloc(250, 98), Buffer.from([20]), Buffer.alloc(20, 99)]);
  const upstream = await fixture(request => reply(request, 0, data));
  const server = await startDnsForwarder("127.0.0.1", () => [upstream.upstream], 0);
  try {
    const resolver = new dns.Resolver();
    resolver.setServers([`127.0.0.1:${server.port}`]);
    expect((await resolver.resolveTxt("printer.local")).flat()).toEqual(["a".repeat(250), "b".repeat(250), "c".repeat(20)]);
    expect(upstream.requests.map(request => request.tcp)).toEqual([false, true]);
  } finally { await server.close(); await upstream.close(); }
});

test("closing a System resolver cancels pending queries before contacting another upstream", async () => {
  const silent = await fixture(() => undefined);
  const second = await fixture(request => reply(request, 0, Buffer.from([192, 168, 10, 20])));
  const server = await startDnsForwarder("127.0.0.1", () => [silent.upstream, second.upstream], 0);
  let closed = false;
  try {
    const resolver = new dns.Resolver({ timeout: 100, tries: 1 });
    resolver.setServers([`127.0.0.1:${server.port}`]);
    const failed = expect(resolver.resolve4("printer.local")).rejects.toThrow();
    for (let attempt = 0; !silent.requests.length && attempt < 100; attempt++) await Bun.sleep(1);
    expect(silent.requests.length).toBe(1);
    await server.close();
    closed = true;
    await failed;
    expect(second.requests).toEqual([]);
  } finally { if (!closed) await server.close(); await silent.close(); await second.close(); }
});
