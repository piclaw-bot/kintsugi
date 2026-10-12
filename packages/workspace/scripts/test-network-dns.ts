// bun packages/workspace/scripts/test-network-dns.ts <local-workspace-image>
// Disposable systemd fixture; no host DNS, deployment or user files are changed.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocker } from "@kintsugi/core";
import { writeWorkspaceNetworkBootstrap } from "../src/network.ts";

const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error("Pass a local workspace image containing systemd");
const name = `kintsugi-network-dns-${crypto.randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "network-dns-integration-"));
async function docker(args: string[], stdin?: string) {
  const result = await runDocker(args, { stdin });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
async function waitReady() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await runDocker(["exec", name, "test", "-f", "/.kintsugi/ready"])).exitCode === 0) return;
    await Bun.sleep(100);
  }
  throw new Error(`DNS fixture did not start: ${await docker(["exec", name, "journalctl", "--no-pager", "-n", "40"])}`);
}
try {
  await docker(["create", "--name", name, "--security-opt", "writable-cgroups=true", "--cgroupns=private", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3", image]);
  await writeWorkspaceNetworkBootstrap(directory, { mode: "lan", resolver: "198.18.0.1", cidrs: ["192.168.10.0/24"], dns: ["192.168.10.53"], search: ["home.arpa"], denied: [] });
  await docker(["cp", directory + "/.", `${name}:/etc`]);
  const token = join(directory, "token");
  await writeFile(token, crypto.randomUUID() + crypto.randomUUID());
  await docker(["cp", token, `${name}:/etc/kintsugi-workspace-gateway-token`]);
  const init = join(directory, "init.sh");
  await writeFile(init, "#!/bin/sh\ncat /etc/resolv.conf >/tmp/network-dns-before-init\n");
  await docker(["cp", init, `${name}:/.kintsugi/init.sh`]);
  await docker(["start", name]);
  await waitReady();
  const expected = "search home.arpa\nnameserver 198.18.0.1";
  assert.equal(await docker(["exec", name, "cat", "/tmp/network-dns-before-init"]), expected);
  console.log("PASS System resolver applied before workspace init");
  await docker(["restart", name]);
  await waitReady();
  assert.equal(await docker(["exec", name, "cat", "/etc/resolv.conf"]), expected);
  console.log("PASS Docker restart reapplies active DNS");
  await docker(["stop", name]);
  await writeWorkspaceNetworkBootstrap(directory, { mode: "off", cidrs: [], dns: [], search: [], denied: [] });
  await docker(["cp", directory + "/.", `${name}:/etc`]);
  await docker(["start", name]);
  await waitReady();
  assert.ok(!(await docker(["exec", name, "cat", "/etc/resolv.conf"])).includes("192.168.10.53"));
  console.log("PASS disabling LAN restores Docker default DNS");
} finally {
  await docker(["rm", "-f", name]);
  await rm(directory, { recursive: true, force: true });
}
