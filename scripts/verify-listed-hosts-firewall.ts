// Manual kernel-backed packet-flow verification. No publication or existing installation access.
// bun scripts/verify-listed-hosts-firewall.ts [--out artifacts/listed-hosts-firewall.json]
import { mkdtemp, rm, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseArgs } from "node:util";
import { workspaceFirewallRules } from "../images/system/src/firewall.ts";
import { offNetworkPolicy, privateNetworkCidrs, type WorkspaceNetworkPolicy } from "../packages/shared/src/network-policy.ts";

const { values } = parseArgs({ options: { out: { type: "string", default: "artifacts/listed-hosts-firewall.json" } } });
const directory = await mkdtemp(join(tmpdir(), "kintsugi-firewall-probe-"));
const container = `kintsugi-firewall-probe-${crypto.randomUUID()}`;
const image = "kintsugi-listed-hosts-firewall-probe:local";
const bridge = "atw-0123456789a";
const policy: WorkspaceNetworkPolicy = {
  mode: "hosts", cidrs: [], dns: [], search: [], denied: ["10.201.1.22/32", "10.200.1.1/32", "fd42:200::1/128"],
  destinations: [{ host: "service.internal", port: 4545, addresses: ["10.201.1.20", "fd42:201::20", "10.201.1.22", "10.202.1.20", "10.200.1.1", "fd42:200::1"] }],
};
async function command(args: string[], timeout = 180_000) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (stderr) console.error(stderr.trim());
  if (code !== 0) throw new Error(`${args[0]} ${args[1]} failed (${code}): ${stdout.slice(-2000)} ${stderr.slice(-2000)}`);
  return stdout;
}
try {
  await Bun.write(join(directory, "Dockerfile"), "FROM oven/bun:1.4.4-alpine\nUSER root\nRUN apk add --no-cache iproute2 nftables openssl\n");
  await copyFile(new URL("./verify-listed-hosts-firewall-probe.ts", import.meta.url), join(directory, "probe.ts"));
  const rules = {
    hosts: policy,
    moved: { ...policy, destinations: [{ host: "service.internal", port: 4545, addresses: ["10.201.1.21", "fd42:201::21"] }] },
    off: offNetworkPolicy(),
    lan: { ...policy, mode: "lan", cidrs: ["10.201.1.0/24", "fd42:201::/64"], destinations: undefined },
    private: { ...policy, mode: "private", cidrs: [...privateNetworkCidrs], destinations: undefined },
  } satisfies Record<string, WorkspaceNetworkPolicy>;
  for (const [name, snapshot] of Object.entries(rules)) await Bun.write(join(directory, `${name}.nft`), workspaceFirewallRules("/sandbox/build", [], false, [{ bridge, policy: snapshot }]));
  console.log(`Building disposable probe tools: ${image}`);
  const build = await command(["docker", "build", "--quiet", "-t", image, directory]);
  console.log(build.trim());
  // Only the generated fixture directory is mounted, read-only. No host network, Docker socket or installation data.
  const output = await command(["docker", "run", "--rm", "--name", container, "--network", "none", "--sysctl", "net.ipv4.ip_forward=1", "--sysctl", "net.ipv6.conf.all.forwarding=1", "--sysctl", "net.ipv6.conf.all.disable_ipv6=0", "--sysctl", "net.ipv6.conf.default.disable_ipv6=0", "--cap-add", "NET_ADMIN", "--cap-add", "SYS_ADMIN", "--security-opt", "seccomp=unconfined", "--mount", `type=bind,source=${directory},target=/probe,readonly`, "--entrypoint", "bun", image, "/probe/probe.ts", "sandbox"], 120_000);
  const result = Value.Parse(Type.Object({ passed: Type.Boolean(), scope: Type.String(), checks: Type.Array(Type.Object({ name: Type.String(), expected: Type.Boolean(), actual: Type.Boolean(), passed: Type.Boolean() })) }), JSON.parse(output));
  const path = resolve(values.out!);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(result, null, 2)}\n`);
  console.log(output.trim());
  console.log(`Verification report: ${path}`);
  // The sandbox reports failed probes and still emits evidence for investigation.
  if (!result.passed) process.exitCode = 1;
} finally {
  const cleanup = Bun.spawn(["docker", "rm", "-f", container], { stdout: "pipe", stderr: "pipe" });
  await Promise.all([cleanup.exited, new Response(cleanup.stdout).text(), new Response(cleanup.stderr).text()]);
  await rm(directory, { recursive: true, force: true });
}
