import { expect, test } from "bun:test";
import { createWorkspaceIngress, managementOriginRejection } from "../src/server/index.ts";

function request(method: string, headers: Record<string, string> = {}, url = "http://localhost:3000/workspaces") {
  return new Request(url, { method, headers });
}

test("every unsafe method requires an exact destination Origin", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "TRACE"]) {
    for (const origin of [undefined, "null", "https://evil.example", "https://localhost:3000", "http://localhost:3001", "http://localhost:3000/", "http://localhost:3000, https://evil.example"]) {
      expect(managementOriginRejection(request(method, origin ? { origin } : {}))?.status).toBe(403);
    }
    expect(managementOriginRejection(request(method, { origin: "http://localhost:3000" }))).toBeUndefined();
  }
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    expect(managementOriginRejection(request(method))).toBeUndefined();
  }
});

test("localhost and changing Tailscale names and ports work without registration", () => {
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:4321", "http://[::1]:3000", "http://kintsugi.localhost:3080", "https://machine.one.ts.net", "https://renamed.two.ts.net:8443"]) {
    expect(managementOriginRejection(request("POST", { origin }, `${origin}/workspaces`))).toBeUndefined();
    expect(managementOriginRejection(request("GET", { origin, upgrade: "websocket" }, `${origin}/cable`))).toBeUndefined();
  }
});

test("WebSocket upgrades require Origin even though their handshake uses GET", () => {
  for (const origin of [undefined, "null", "http://preview.localhost:41001"]) {
    const headers = { upgrade: "WebSocket", origin: origin ?? "" };
    expect(managementOriginRejection(request("GET", headers))?.status).toBe(403);
  }
});

test("forwarded/public host metadata cannot change the destination identity", () => {
  const origin = "https://evil.example";
  const headers = {
    origin, "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", forwarded: "host=evil.example;proto=https",
    "x-kintsugi-public-origin": origin, "x-kintsugi-origin-context": origin,
  };
  expect(managementOriginRejection(request("POST", headers), "172.17.0.2")?.status).toBe(403);
  expect(managementOriginRejection(request("POST", headers), "127.0.0.1")?.status).toBe(403);
});

test("TLS termination may supply protocol only through trusted loopback ingress", () => {
  for (const method of ["POST", "GET"]) {
    const headers = { origin: "https://machine.ts.net", "x-forwarded-proto": "https", upgrade: "websocket" };
    const incoming = request(method, headers, "http://machine.ts.net/terminal-processes/demo/ws");
    expect(managementOriginRejection(incoming, "172.17.0.2")?.status).toBe(403);
    expect(managementOriginRejection(incoming, "127.0.0.1")).toBeUndefined();
    for (const protocol of ["https,http", "ftp", "", "HTTPS"]) {
      expect(managementOriginRejection(request(method, { ...headers, "x-forwarded-proto": protocol }, incoming.url), "127.0.0.1")?.status).toBe(403);
    }
  }
  const forwarded = request("POST", { origin: "https://machine.ts.net", "x-forwarded-proto": "https" }, "http://machine.ts.net/workspaces");
  for (const address of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) expect(managementOriginRejection(forwarded, address)).toBeUndefined();
  for (const address of [undefined, "172.17.0.1", "100.64.0.1", "8.8.8.8", "::ffff:172.17.0.1"]) expect(managementOriginRejection(forwarded, address)?.status).toBe(403);
});

test("nested ingress translation accepts local Origin but preserves foreign-origin denial", () => {
  const headers = {
    origin: "http://localhost:3000", "x-forwarded-proto": "http", "x-kintsugi-public-origin": "https://preview.example:41001",
    "x-kintsugi-origin-context": "http://localhost:3000",
  };
  expect(managementOriginRejection(request("POST", headers), "127.0.0.1")).toBeUndefined();
  expect(managementOriginRejection(request("POST", { ...headers, "x-kintsugi-origin-context": "null" }), "127.0.0.1")?.status).toBe(403);
  expect(managementOriginRejection(request("POST", { ...headers, origin: "https://preview.example:41001" }), "127.0.0.1")?.status).toBe(403);
});

test("cross-origin HTML form posts never reach management handlers over HTTP", async () => {
  const dispatched: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    const rejection = managementOriginRejection(request, server.requestIP(request)?.address);
    if (rejection) return rejection;
    dispatched.push(new URL(request.url).pathname);
    return new Response("dispatched", { status: 200 });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    for (const path of ["/workspace-templates", "/workspaces", "/host/sample", "/settings/theme"]) {
      for (const foreign of [undefined, "null", "https://artifact.example.com"]) {
        const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
        if (foreign) headers.set("origin", foreign);
        const response = await fetch(`${origin}${path}`, {
          method: "POST", headers,
          body: "gitUrl=http%3A%2F%2F127.0.0.1%3A41091%2Fpwn.git&workspaceTemplate=pwn",
        });
        expect(response.status).toBe(403);
        expect(await response.text()).toBe("Forbidden management origin");
      }
    }
    expect(dispatched).toEqual([]);
    const response = await fetch(`${origin}/workspaces`, { method: "POST", headers: { origin } });
    expect(response.status).toBe(200);
    await response.text();
    expect(dispatched).toEqual(["/workspaces"]);
  } finally {
    server.stop(true);
  }
});

test("production preview ingress translates same-origin requests and blocks localhost coincidences", async () => {
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    return managementOriginRejection(request, server.requestIP(request)?.address) ?? new Response("accepted");
  } });
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = portProbe.port!;
  portProbe.stop(true);
  const ingress = createWorkspaceIngress({
    hostname: "127.0.0.1", originPortRange: { start: port, end: port },
    parentOriginPublisher: { kind: "tailscale", async publish(port) { return `https://dynamic-preview.example:${port}`; } },
    async resolveWorkspace() {},
    resolveApp() { return undefined; },
    resolvePort(_id, port, protocol, url) {
      return { kind: "http", target: new URL(`${protocol}://127.0.0.1:${port}${url.pathname}${url.search}`) };
    },
  });
  try {
    const origin = await ingress.publishPort("one", backend.port!);
    for (const browserOrigin of [origin, "null", "https://attacker.example", `http://localhost:${backend.port}`]) {
      const response = await fetch(`http://127.0.0.1:${port}/workspaces`, {
        method: "POST", headers: { host: new URL(origin).host, origin: browserOrigin, "x-kintsugi-origin-context": browserOrigin },
      });
      expect(response.status).toBe(browserOrigin === origin ? 200 : 403);
      await response.text();
    }
  } finally { await ingress.stopAll(); backend.stop(true); }
});
