import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { validateProxyAccess } from "../packages/shared/src/proxy-access.ts";

export function caddyRecipe(origin: string, upstream: string, previewPorts: string, bind: string, adminOrigin?: string, adminUpstream?: string) {
  const [start, end] = previewPorts.split(":").map(Number);
  const config = validateProxyAccess({ origin, previewPorts: { start: start!, end: end! } });
  const bindings = bind.split(",");
  if (!bindings.every(address => isIP(address))) throw new Error("--bind requires LAN IPv4/IPv6 addresses, comma-separated");
  for (const address of [upstream, ...(adminUpstream ? [adminUpstream] : [])]) {
    if (!/^127\.(?:\d{1,3}\.){2}\d{1,3}:\d{4,5}$/.test(address)) throw new Error("Proxy upstreams must be explicit loopback IPv4 addresses and ports");
    const url = new URL(`http://${address}`); if (!url.port) throw new Error("Invalid proxy upstream port");
  }
  function block(origins: string[], target: string) {
    return `${origins.join(", ")} {\n    bind ${bindings.join(" ")}\n${origins[0]!.startsWith("https:") ? "    tls internal\n" : ""}    reverse_proxy ${target} {\n        flush_interval -1\n    }\n}\n`;
  }
  const url = new URL(config.origin);
  const origins = [config.origin];
  for (let port = start!; port <= end!; port++) { const preview = new URL(url); preview.port = String(port); origins.push(preview.origin); }
  let result = "# UI is trusted-LAN access, not a token-authenticated API. No Host/Origin rewriting.\n" + block(origins, upstream);
  if (adminOrigin) {
    const admin = new URL(adminOrigin);
    if (admin.protocol !== "https:" || admin.origin !== adminOrigin || admin.username || admin.password || admin.hostname !== url.hostname || origins.includes(adminOrigin) || !adminUpstream) throw new Error("Admin origin requires a distinct HTTPS port on the UI hostname and --admin-upstream");
    result += "\n# Clients must supply their own bearer token.\n" + block([adminOrigin], adminUpstream);
  } else if (adminUpstream) throw new Error("--admin-upstream requires --admin-origin");
  return result;
}
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  await new Response(child.stderr).text();
  return { status, output: output.trim() };
}
export async function deploymentPreflight(storage: string, mode: string, origin?: string, images: string[] = []) {
  if (!["erofs", "overlayfs"].includes(storage) || !["localhost", "proxy", "tailscale"].includes(mode)) throw new Error("Specify storage and access intent");
  if (mode === "proxy" && !origin) throw new Error("Proxy access requires --origin");
  if (origin) validateProxyAccess({ origin, previewPorts: { start: 41000, end: 41009 } });
  const kernel = await command(["uname", "-smr"]);
  const filesystems = await readFile("/proc/filesystems", "utf8");
  const docker = await command(["docker", "info", "--format", "{{json .DriverStatus}}"]);
  const containers = await command(["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}"]);
  const disk = await command(["df", "-h", "/"]);
  const listeners = await command(["ss", "-lnt"]);
  const interfaces = await command(["ip", "-j", "address", "show"]);
  const services = await command(["systemctl", "list-units", "--type=service", "--state=running", "--no-pager", "--no-legend"]);
  const imageChecks = [];
  for (const image of images) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) throw new Error("Invalid image reference");
    const checked = await command(["docker", "image", "inspect", "--format", '{{.Id}} {{.Os}}/{{.Architecture}} storage={{index .Config.Labels "kintsugi.storage-drivers"}} deployment={{index .Config.Labels "kintsugi.deployment-config"}}', image]);
    imageChecks.push({ image, ...checked });
  }
  return { readOnly: true, kernel: kernel.output, architecture: process.arch, storageDriver: storage, accessMode: mode, uiOrigin: origin, kernelSupport: { overlayfs: /\boverlay\b/.test(filesystems), erofs: /\berofs\b/.test(filesystems) }, docker, containers, disk, listeners, interfaces, services, imageChecks, pendingActions: ["Read the README at the selected release; install the release, do not clone a stale development checkout", "Preserve unrelated services, containers and volumes; do not upgrade the kernel before considering supported storage", "Verify image architecture, storage/deployment capabilities and immutable pins before replacement", "Record UI/API reachability intent, trusted interfaces, port conflicts and available backing storage", "Reserve DHCP addresses; restrict Avahi to the intended interface; verify IPv4/IPv6 and client CA trust", "Probe from a second physical LAN client; host-local checks do not prove remote reachability"] };
}
if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { origin: { type: "string" }, upstream: { type: "string", default: "127.0.0.1:3000" }, "preview-ports": { type: "string", default: "41000:41009" }, bind: { type: "string" }, "admin-origin": { type: "string" }, "admin-upstream": { type: "string" }, storage: { type: "string", default: "erofs" }, mode: { type: "string" }, image: { type: "string", multiple: true } } });
  if (positionals[0] === "caddyfile") {
    if (!values.origin || !values.bind) throw new Error("caddyfile requires --origin and --bind");
    console.log(caddyRecipe(values.origin, values.upstream!, values["preview-ports"]!, values.bind, values["admin-origin"], values["admin-upstream"]));
  } else if (positionals[0] === "preflight") {
    if (!values.mode) throw new Error("preflight requires --mode localhost|proxy|tailscale");
    console.log(JSON.stringify(await deploymentPreflight(values.storage!, values.mode, values.origin, values.image), null, 2));
  } else throw new Error("Usage: bun scripts/deployment.ts preflight|caddyfile --mode MODE --origin URL --bind LAN_IP (see docs/automation.md)");
}
