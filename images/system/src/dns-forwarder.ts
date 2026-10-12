import { createSocket } from "node:dgram";
import { connect, createServer, type Socket } from "node:net";
import { randomInt } from "node:crypto";

export interface DnsUpstream { address: string; port?: number }
class DnsPacketError extends Error {}
class DnsTransportError extends Error {}
class DnsCancelledError extends Error {}

/** Decode only the question; upstream replies, TTLs and record types pass through. */
function question(packet: Buffer) {
  if (packet.length < 12 || packet.readUInt16BE(4) !== 1) throw new DnsPacketError("Expected one DNS question");
  const labels: string[] = [];
  const visited = new Set<number>();
  let offset = 12;
  let end = 0;
  let length = 0;
  while (true) {
    if (offset >= packet.length || visited.has(offset)) throw new DnsPacketError("Invalid DNS name");
    visited.add(offset);
    const size = packet[offset++]!;
    if ((size & 0xc0) === 0xc0) {
      if (offset >= packet.length) throw new DnsPacketError("Invalid DNS pointer");
      if (!end) end = offset + 1;
      offset = ((size & 0x3f) << 8) | packet[offset]!;
      continue;
    }
    if (size > 63 || offset + size > packet.length || (length += size + 1) > 255) throw new DnsPacketError("Invalid DNS label");
    if (!size) break;
    labels.push(Buffer.from(packet.subarray(offset, offset + size).map(byte => byte >= 65 && byte <= 90 ? byte + 32 : byte)).toString("hex"));
    offset += size;
  }
  end ||= offset;
  if (end + 4 > packet.length) throw new DnsPacketError("Missing DNS question type");
  return { key: `${labels.join(".")}:${packet.readUInt16BE(end)}:${packet.readUInt16BE(end + 2)}`, end: end + 4 };
}

function errorResponse(query: Buffer, code: number, truncated = false): Buffer {
  let end = 12;
  let count = 0;
  try { end = question(query).end; count = 1; }
  catch (error) { if (!(error instanceof DnsPacketError)) throw error; }
  const response = Buffer.alloc(end);
  query.copy(response, 0, 0, Math.min(end, query.length));
  response.writeUInt16BE(0x8080 | (query.length >= 4 ? query.readUInt16BE(2) & 0x0110 : 0) | (truncated ? 0x0200 : 0) | code, 2);
  response.writeUInt16BE(count, 4);
  response.fill(0, 6, 12);
  return response;
}

function matchingResponse(response: Buffer, query: Buffer): boolean {
  if (response.length < 12 || response.readUInt16BE(0) !== query.readUInt16BE(0) || !(response.readUInt16BE(2) & 0x8000)) return false;
  // Some error responses omit the question entirely.
  if (response.readUInt16BE(4) === 0) return (response.readUInt16BE(2) & 15) !== 0;
  try { return question(response).key === question(query).key; }
  catch (error) { if (error instanceof DnsPacketError) return false; throw error; }
}

async function udpQuery(query: Buffer, upstream: DnsUpstream, timeout: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(upstream.address.includes(":") ? "udp6" : "udp4");
    let finished = false;
    const finish = (error?: Error, response?: Buffer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.close();
      if (error) reject(error); else resolve(response!);
    };
    const timer = setTimeout(() => finish(new DnsTransportError("DNS upstream timed out")), timeout);
    const onAbort = () => finish(new DnsCancelledError());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    socket.once("error", error => finish(new DnsTransportError(error.message)));
    socket.on("message", response => { if (matchingResponse(response, query)) finish(undefined, response); });
    socket.connect(upstream.port ?? 53, upstream.address, () => socket.send(query));
  });
}

async function tcpQuery(query: Buffer, upstream: DnsUpstream, timeout: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: upstream.address, port: upstream.port ?? 53 });
    let buffer = Buffer.alloc(0);
    let finished = false;
    const finish = (error?: Error, response?: Buffer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error); else resolve(response!);
    };
    const timer = setTimeout(() => finish(new DnsTransportError("DNS upstream timed out")), timeout);
    const onAbort = () => finish(new DnsCancelledError());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    socket.on("error", error => finish(new DnsTransportError(error.message)));
    socket.on("end", () => finish(new DnsTransportError("DNS upstream closed before its reply")));
    socket.on("connect", () => {
      const frame = Buffer.alloc(query.length + 2);
      frame.writeUInt16BE(query.length);
      query.copy(frame, 2);
      socket.write(frame);
    });
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65537) return finish(new DnsTransportError("Oversized DNS reply"));
      if (buffer.length < 2) return;
      const length = buffer.readUInt16BE(0);
      if (buffer.length >= length + 2) {
        const response = buffer.subarray(2, length + 2);
        finish(matchingResponse(response, query) ? undefined : new DnsTransportError("Invalid DNS upstream reply"), response);
      }
    });
  });
}

/** Expected network failures and negative answers try the next configured
 * upstream. No OS/public resolver fallback, cache, multicast or DNS synthesis. */
export async function forwardDns(query: Buffer, upstreams: DnsUpstream[], tcp = false, timeout = 3000, signal?: AbortSignal): Promise<Buffer> {
  try {
    question(query);
    if ((query.readUInt16BE(2) & 0xf800) !== 0) return errorResponse(query, 4);
  } catch (error) { if (error instanceof DnsPacketError) return errorResponse(query, 1); throw error; }
  const request = Buffer.from(query);
  request.writeUInt16BE(randomInt(65536));
  let negative: Buffer | undefined;
  let failed = false;
  for (const upstream of upstreams) {
    if (signal?.aborted) throw new DnsCancelledError();
    try {
      let response = tcp ? await tcpQuery(request, upstream, timeout, signal) : await udpQuery(request, upstream, timeout, signal);
      if (!tcp && (response.readUInt16BE(2) & 0x0200)) response = await tcpQuery(request, upstream, timeout, signal);
      const code = response.readUInt16BE(2) & 15;
      if (code === 2 || code === 5) { failed = true; continue; }
      if (code === 3 || (code === 0 && response.readUInt16BE(6) === 0)) { negative = response; continue; }
      response.writeUInt16BE(query.readUInt16BE(0));
      return response;
    } catch (error) { if (!(error instanceof DnsTransportError)) throw error; failed = true; }
  }
  if (failed || !negative) return errorResponse(query, 2);
  negative.writeUInt16BE(query.readUInt16BE(0));
  return negative;
}

export interface DnsForwarder { port: number; close(): Promise<void> }
/** A view bound to one internal workspace address, with bounded work and idle
 * TCP clients. The caller owns firewall ACLs and the upstream policy snapshot. */
export async function startDnsForwarder(address: string, upstreams: () => DnsUpstream[], port = 53): Promise<DnsForwarder> {
  const udp = createSocket("udp4");
  const clients = new Set<Socket>();
  const pending = new Set<AbortController>();
  let active = 0;
  let closed = false;
  async function resolve(query: Buffer, tcp: boolean) {
    if (active >= 64) return errorResponse(query, 2);
    active++;
    const abort = new AbortController();
    pending.add(abort);
    try { return await forwardDns(query, upstreams(), tcp, 3000, abort.signal); }
    catch (error) { if (closed && error instanceof DnsCancelledError) return errorResponse(query, 2); throw error; }
    finally { pending.delete(abort); active--; }
  }
  udp.on("message", (query, remote) => {
    void resolve(query, false).then(response => {
      if (!closed) udp.send(response.length > 512 ? errorResponse(query, 0, true) : response, remote.port, remote.address);
    });
  });
  await new Promise<void>((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(port, address, () => { udp.removeListener("error", reject); resolve(); });
  });
  const tcp = createServer(socket => {
    clients.add(socket);
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("close", () => clients.delete(socket));
    socket.on("error", error => {
      const code = "code" in error ? error.code : undefined;
      if (!["ECONNRESET", "EPIPE", "ETIMEDOUT"].some(expected => expected === code)) throw error;
    });
    void (async () => {
      let buffer = Buffer.alloc(0);
      for await (const chunk of socket) {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 65537) { socket.destroy(); return; }
        while (buffer.length >= 2) {
          const length = buffer.readUInt16BE(0);
          if (length < 12) { socket.destroy(); return; }
          if (buffer.length < length + 2) break;
          const query = buffer.subarray(2, length + 2);
          buffer = buffer.subarray(length + 2);
          const response = await resolve(query, true);
          if (socket.destroyed) return;
          const frame = Buffer.alloc(response.length + 2);
          frame.writeUInt16BE(response.length);
          response.copy(frame, 2);
          socket.write(frame);
        }
      }
    })().catch(error => {
      if (closed && error?.code === "ABORT_ERR") return;
      if (!["ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(error?.code)) throw error;
    });
  });
  tcp.maxConnections = 64;
  try {
    await new Promise<void>((resolve, reject) => {
      tcp.once("error", reject);
      // Port 0 in fixtures must use the same allocated UDP/TCP port.
      tcp.listen(udp.address().port, address, () => { tcp.removeListener("error", reject); resolve(); });
    });
  } catch (error) { udp.close(); throw error; }
  return { port: udp.address().port, close: async () => {
    closed = true;
    for (const abort of pending) abort.abort();
    for (const client of clients) client.destroy();
    await Promise.all([new Promise<void>(resolve => udp.close(() => resolve())), new Promise<void>((resolve, reject) => tcp.close(error => error ? reject(error) : resolve()))]);
  } };
}
