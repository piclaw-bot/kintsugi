// Runs only inside verify-listed-hosts-firewall.ts's disposable, network-isolated container.
import { createServer, connect } from "node:net";
import { createSocket } from "node:dgram";
import { existsSync, writeFileSync } from "node:fs";
const mode = process.argv[2];
const token = "snapshot-grant";
const expectedErrors = ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"];
function expected(error: NodeJS.ErrnoException) { if (!expectedErrors.includes(error.code ?? "")) throw error; }
async function exchange(host: string, port: number, udp = false): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = udp ? createSocket(host.includes(":") ? "udp6" : "udp4") : connect(port, host);
    let finished = false;
    const done = (allowed: boolean, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if ("destroy" in socket) socket.destroy(); else socket.close();
      if (error) reject(error); else resolve(allowed);
    };
    const timer = setTimeout(() => done(false), 700);
    socket.once("error", (error: NodeJS.ErrnoException) => { if (expectedErrors.includes(error.code ?? "")) done(false); else done(false, error); });
    if ("destroy" in socket) {
      socket.once("connect", () => socket.write("probe"));
      socket.once("data", data => done(data.toString() === token));
    } else {
      socket.once("message", data => done(data.toString() === token));
      socket.send("probe", port, host);
    }
  });
}
if (mode === "server") {
  const hosts = process.argv.slice(3);
  for (const host of hosts) for (const port of [4545, 4546]) {
    const tcp = createServer(socket => {
      socket.on("data", () => socket.write(token));
      socket.on("error", expected);
    });
    await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, host, resolve); });
    const udp = createSocket(host.includes(":") ? "udp6" : "udp4");
    udp.on("message", (_data, remote) => udp.send(token, remote.port, remote.address));
    await new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(port, host, resolve); });
  }
  console.log("listeners-ready");
} else if (mode === "probe") {
  console.log(await exchange(process.argv[3]!, Number(process.argv[4]), process.argv[5] === "udp"));
} else if (mode === "persistent") {
  const socket = connect(4545, "10.201.1.20");
  socket.on("error", expected);
  socket.once("connect", () => socket.write("first"));
  const first = await new Promise<Buffer>(resolve => socket.once("data", resolve));
  if (first.toString() !== token) throw new Error("Established connection did not reach the service");
  writeFileSync("/tmp/revocation-ready", "ready");
  while (!existsSync("/tmp/revocation-applied")) await Bun.sleep(20);
  const stillAllowed = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), 700);
    socket.once("data", data => { clearTimeout(timer); resolve(data.toString() === token); });
    socket.write("after-off");
  });
  socket.destroy();
  console.log(stillAllowed);
} else if (mode === "sandbox") {
  const checks: Array<{ name: string; expected: boolean; actual: boolean; passed: boolean }> = [];
  const workers: ReturnType<typeof Bun.spawn>[] = [];
  function run(args: string[]): string {
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 5000 });
    if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  }
  const ip = (...args: string[]) => run(["ip", ...args]);
  const ns = (name: string, ...args: string[]) => ip("-n", name, ...args);
  const add = (name: string, address: string, device: string) => ns(name, "address", "add", address, "dev", device, ...(address.includes(":") ? ["nodad"] : []));
  const root = (address: string, device: string) => ip("address", "add", address, "dev", device, ...(address.includes(":") ? ["nodad"] : []));
  const apply = (snapshot: string) => run(["nft", "-f", `/probe/${snapshot}.nft`]);
  function spawnServer(namespace: string | undefined, hosts: string[]) {
    const args = ["bun", "/probe/probe.ts", "server", ...hosts];
    workers.push(Bun.spawn(namespace ? ["ip", "netns", "exec", namespace, ...args] : args, { stdout: "pipe", stderr: "pipe" }));
  }
  function record(name: string, wanted: boolean, actual: boolean) { checks.push({ name, expected: wanted, actual, passed: actual === wanted }); }
  function probe(name: string, host: string, port: number, wanted: boolean, udp = false) {
    const actual = run(["ip", "netns", "exec", "client", "bun", "/probe/probe.ts", "probe", host, String(port), udp ? "udp" : "tcp"]);
    if (actual !== "true" && actual !== "false") throw new Error("Invalid network probe result");
    record(name, wanted, actual === "true");
  }
  try {
    for (const name of ["client", "server", "peer"]) { ip("netns", "add", name); ns(name, "link", "set", "lo", "up"); }
    function bridge(namespace: string, name: string, gateway4: string, address4: string, gateway6?: string, address6?: string) {
      ip("link", "add", name, "type", "bridge");
      ip("link", "set", name, "up");
      root(gateway4, name);
      ip("link", "add", `${namespace}-root`, "type", "veth", "peer", "name", `${namespace}-ns`);
      ip("link", "set", `${namespace}-root`, "master", name);
      ip("link", "set", `${namespace}-root`, "up");
      ip("link", "set", `${namespace}-ns`, "netns", namespace);
      ns(namespace, "link", "set", `${namespace}-ns`, "up");
      add(namespace, address4, `${namespace}-ns`);
      ns(namespace, "route", "add", "default", "via", gateway4.split("/")[0]!);
      if (gateway6 && address6) {
        root(gateway6, name); add(namespace, address6, `${namespace}-ns`);
        ns(namespace, "-6", "route", "add", "default", "via", gateway6.split("/")[0]!);
      }
    }
    bridge("client", "atw-0123456789a", "10.200.1.1/24", "10.200.1.2/24", "fd42:200::1/64", "fd42:200::2/64");
    bridge("peer", "atw-fedcba98765", "10.202.1.1/24", "10.202.1.20/24");
    ip("link", "add", "uplink", "type", "veth", "peer", "name", "service");
    ip("link", "set", "uplink", "up"); ip("link", "set", "service", "netns", "server");
    ns("server", "link", "set", "service", "up");
    root("10.201.1.1/24", "uplink"); root("fd42:201::1/64", "uplink");
    root("8.8.8.1/24", "uplink"); root("fd7a:115c:a1e0::1/64", "uplink");
    const hosts = ["10.201.1.20", "10.201.1.21", "10.201.1.22", "fd42:201::20", "fd42:201::21", "8.8.8.20", "fd7a:115c:a1e0::20"];
    for (const host of hosts) add("server", `${host}/${host.includes(":") ? "64" : "24"}`, "service");
    ns("server", "route", "add", "default", "via", "10.201.1.1");
    ns("server", "-6", "route", "add", "default", "via", "fd42:201::1");
    // Newly created link-local IPv6 addresses need DAD before first-hop neighbour discovery.
    const addressesReady = Date.now() + 5000;
    while ([ip("-6", "address", "show", "tentative"), ...["client", "server", "peer"].map(name => ns(name, "-6", "address", "show", "tentative"))].some(Boolean)) {
      if (Date.now() > addressesReady) throw new Error("IPv6 addresses did not finish duplicate-address detection");
      await Bun.sleep(20);
    }
    spawnServer("server", hosts); spawnServer("peer", ["10.202.1.20"]); spawnServer(undefined, ["10.200.1.1", "fd42:200::1"]);
    for (const worker of workers) {
      const reader = worker.stdout.getReader();
      const ready = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error("Probe listeners did not start"); })]);
      if (!new TextDecoder().decode(ready.value).includes("listeners-ready")) throw new Error("Probe listeners failed");
      reader.releaseLock();
    }
    // Positive controls prove every blocked destination/port/protocol has a working listener and route.
    for (const host of [...hosts, "10.202.1.20", "10.200.1.1", "fd42:200::1"]) {
      probe(`baseline TCP ${host}`, host, 4545, true);
      probe(`baseline alternate port ${host}`, host, 4546, true);
      probe(`baseline UDP ${host}`, host, 4545, true, true);
    }
    apply("hosts");
    for (const host of ["10.201.1.20", "fd42:201::20"]) {
      probe(`hosts listed TCP ${host}`, host, 4545, true);
      probe(`hosts wrong TCP port ${host}`, host, 4546, false);
      probe(`hosts UDP excluded ${host}`, host, 4545, false, true);
    }
    for (const host of ["10.201.1.21", "fd42:201::21", "10.201.1.22", "10.202.1.20", "10.200.1.1", "fd42:200::1", "fd7a:115c:a1e0::20"]) probe(`hosts deny ${host}`, host, 4545, false);
    probe("hosts public internet semantics", "8.8.8.20", 4545, true);
    apply("moved");
    for (const host of ["10.201.1.20", "fd42:201::20"]) probe(`new snapshot revokes ${host}`, host, 4545, false);
    for (const host of ["10.201.1.21", "fd42:201::21"]) probe(`new snapshot grants ${host}`, host, 4545, true);
    apply("hosts");
    const persistent = Bun.spawn(["ip", "netns", "exec", "client", "bun", "/probe/probe.ts", "persistent"], { stdout: "pipe", stderr: "pipe" });
    workers.push(persistent);
    const deadline = Date.now() + 5000;
    while (!existsSync("/tmp/revocation-ready")) { if (Date.now() > deadline) throw new Error("Established connection did not start"); await Bun.sleep(20); }
    apply("off"); writeFileSync("/tmp/revocation-applied", "off");
    const [code, output] = await Promise.all([persistent.exited, new Response(persistent.stdout).text()]);
    if (code !== 0 || !["true", "false"].includes(output.trim())) throw new Error("Established connection probe failed");
    record("Off revokes an established TCP connection", false, output.trim() === "true");
    for (const host of ["10.201.1.20", "fd42:201::20"]) probe(`Off closes private access ${host}`, host, 4545, false);
    probe("Off preserves public internet semantics", "8.8.8.20", 4545, true);
    apply("lan");
    for (const host of ["10.201.1.21", "fd42:201::21"]) {
      probe(`LAN broad CIDR TCP ${host}`, host, 4546, true);
      probe(`LAN broad CIDR UDP ${host}`, host, 4545, true, true);
    }
    probe("LAN denial overrides CIDR", "10.201.1.22", 4545, false);
    apply("private");
    probe("routed-private preserves private access", "10.201.1.21", 4546, true);
    probe("routed-private preserves tailnet exclusion", "fd7a:115c:a1e0::20", 4545, false);
    probe("routed-private preserves peer isolation", "10.202.1.20", 4545, false);
    console.log(JSON.stringify({ passed: checks.every(check => check.passed), scope: "Native IPv4/IPv6 forwarding and revocation using production nftables rules; public address is a sandbox-local service, not an internet endpoint. DNS resolution, proxy hostname checks and build-client cgroups are covered separately, not by this probe.", checks }));
  } finally {
    for (const worker of workers) worker.kill();
    await Promise.all(workers.map(async worker => { await worker.exited; const stderr = await new Response(worker.stderr).text(); if (stderr) console.error(stderr); }));
  }
} else throw new Error("Unknown firewall probe operation");
