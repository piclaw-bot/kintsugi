import { expect, test } from "bun:test";
import { localTarget } from "./local-ingress.ts";

test("local host routing exposes only app, diagnostics, and preview listener range", () => {
  expect(localTarget("kintsugi.localhost:55123", 3000)).toBe(3000);
  expect(localTarget("kintsugi.localhost:55123", 3001)).toBe(3001);
  expect(localTarget("system.kintsugi.localhost:55123", 3000)).toBe(3001);
  expect(localTarget("p41001.kintsugi.localhost:55123", 3000)).toBe(41001);
  for (const host of ["localhost", "p2375.kintsugi.localhost", "p42000.kintsugi.localhost", "p41001.kintsugi.localhost.evil.com", "evil.com"]) expect(localTarget(host, 3000)).toBeUndefined();
});

test("local routing preserves HTTP cookies and WebSocket traffic", async () => {
  const { startLocalIngress } = await import("./local-ingress.ts");
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(request.headers.get("host"), { headers: { "set-cookie": "preview=1; SameSite=Lax" } });
    }, websocket: { message(socket, message) { socket.send(message); } },
  });
  const proxy = startLocalIngress(() => backend.port!, 0);
  const address = { port: proxy.port };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, { headers: { host: `kintsugi.localhost:${address.port}` } });
    expect(await response.text()).toBe(`kintsugi.localhost:${address.port}`);
    expect(response.headers.get("set-cookie")).toBe("preview=1; SameSite=Lax");
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/`, { headers: { host: `kintsugi.localhost:${address.port}` } });
      socket.onopen = () => socket.send("hello");
      socket.onmessage = event => { expect(event.data).toBe("hello"); socket.close(); resolve(); };
      socket.onerror = reject;
    });
  } finally { proxy.stop(true); backend.stop(true); }
});

test("proxy access exposes only the public UI origin and isolated preview ports", async () => {
  const { proxyTarget } = await import("./local-ingress.ts");
  const config = { origin: "https://agent-host.local", previewPorts: { start: 41000, end: 41009 } };
  expect(proxyTarget("agent-host.local", config, 3000)).toBe(3000);
  expect(proxyTarget("agent-host.local:41001", config, 3000)).toBe(41001);
  for (const host of ["agent-host.local:3001", "agent-host.local:41010", "system.agent-host.local", "agent-host.local.evil", "127.0.0.1:2375", "agent-host.local:041001"]) expect(proxyTarget(host, config, 3000)).toBeUndefined();
});
test("proxy termination pins scheme and preserves foreign/missing origin rejection", async () => {
  const { startProxyIngress } = await import("./local-ingress.ts");
  const { managementOriginRejection } = await import("../../../packages/proxy-ingress/src/server/management-origin.ts");
  const backend = Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){return managementOriginRejection(request,"127.0.0.1") ?? Response.json({host:request.headers.get("host"),scheme:request.headers.get("x-forwarded-proto"),forwarded:request.headers.get("forwarded")});}});
  const config = { origin: "https://agent-host.local", previewPorts: { start: 41000, end: 41009 } };
  const proxy = startProxyIngress(()=>backend.port!,()=>config,0);
  try {
    const target = "http://127.0.0.1:"+proxy.port+"/probe";
    const good = await fetch(target,{method:"POST",headers:{host:"agent-host.local",origin:config.origin,"x-forwarded-proto":"http",forwarded:"host=evil;proto=http"}});
    expect(good.status).toBe(200); expect(await good.json()).toEqual({host:"agent-host.local",scheme:"https",forwarded:null});
    for (const origin of ["https://foreign.example","http://agent-host.local","null",""]) {
      const headers = new Headers({host:"agent-host.local"}); if(origin)headers.set("origin",origin);
      expect((await fetch(target,{method:"POST",headers})).status).toBe(403);
    }
    expect((await fetch(target,{headers:{host:"system.agent-host.local"}})).status).toBe(404);
  } finally {proxy.stop(true);backend.stop(true);}
});
