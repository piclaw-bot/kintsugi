// bun packages/workspace-image/scripts/test-isolation.ts <local-workspace-image>
// Real runtime/protocol tests; no browser or UI assertions.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocker } from "@kintsugi/core";

const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error("Pass a local workspace image containing the current runtime and Docker guard");
const name = `kintsugi-isolation-${crypto.randomUUID()}`;
const sibling = `${name}-sibling`;
const directory = await mkdtemp(join(tmpdir(), "kintsugi-isolation-"));
async function docker(args: string[], check = true, stdin?: string) {
  const result = await runDocker(args, { stdin });
  if (check) assert.equal(result.exitCode, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}
async function exec(...args: string[]) { return (await docker(["exec", name, ...args])).stdout.trim(); }
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await docker(["exec", name, "test", "-f", "/.kintsugi/ready"], false)).exitCode === 0) return;
    await Bun.sleep(200);
  }
  const logs = await docker(["exec", name, "journalctl", "--no-pager", "-n", "50"], false);
  throw new Error(`Workspace did not become ready: ${logs.stdout}\n${logs.stderr}`);
}
try {
  await writeFile(join(directory, "token"), crypto.randomUUID());
  await writeFile(join(directory, "docker-support"), "disabled\nhttps://kintsugi.example/workspace-templates/test/settings?section=privileged\n");
  await docker(["run", "-d", "--name", sibling, "--entrypoint", "/bin/sleep", image, "infinity"]);
  await docker(["create", "--name", name, "--security-opt", "writable-cgroups=true", "--cgroupns=private", "--memory=512m", "--memory-swap=512m", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3", image]);
  await docker(["cp", join(directory, "token"), `${name}:/etc/kintsugi-workspace-gateway-token`]);
  await docker(["cp", join(directory, "docker-support"), `${name}:/etc/kintsugi/docker-support`]);
  await docker(["start", name]);
  await ready();
  const host = JSON.parse((await docker(["inspect", "--format", "{{json .HostConfig}}", name])).stdout);
  assert.equal(host.Privileged, false);
  assert.deepEqual(host.SecurityOpt, ["writable-cgroups=true"]);
  assert.equal(host.CgroupnsMode, "private");
  assert.equal(await exec("systemctl", "is-active", "kintsugi-tmux.service"), "active");
  assert.equal(await exec("systemctl", "is-active", "kintsugi-gateway.service"), "active");
  assert.equal(await exec("cat", "/sys/fs/cgroup/memory.max"), "536870912");
  console.log("PASS: non-privileged workspace boots with tmux, gateway and its resource budget");

  await exec("python3", "-c", `import os, pathlib
status = pathlib.Path('/proc/self/status').read_text()
assert 'Seccomp:\\t2' in status, status
cap = int(next(line.split()[1] for line in status.splitlines() if line.startswith('CapBnd:')), 16)
assert not cap & (1 << 21), 'CAP_SYS_ADMIN must not be granted'
os.mkdir('/sys/fs/cgroup/delegation-probe')
assert pathlib.Path('/sys/fs/cgroup/delegation-probe/cgroup.procs').exists()
os.rmdir('/sys/fs/cgroup/delegation-probe')
assert not pathlib.Path('/dev/sda1').exists()
os.mknod('/tmp/host-disk-probe', 0o600 | 0o60000, os.makedev(8,1))
try: fd = os.open('/tmp/host-disk-probe', os.O_RDONLY)
except PermissionError: pass
else: os.close(fd); raise AssertionError('raw host disk can be opened')
`);
  const siblingId = (await docker(["inspect", "--format", "{{.Id}}", sibling])).stdout.trim();
  const hierarchy = await exec("find", "/sys/fs/cgroup", "-type", "d");
  assert(!hierarchy.includes(siblingId), "sibling cgroup must not be visible");
  await exec("sh", "-ec", `test ! -e /sys/fs/cgroup/../docker-${siblingId}.scope; test ! -e /sys/fs/cgroup/../${siblingId}`);
  console.log("PASS: private cgroup delegation, no sibling access, seccomp and denied raw-device reads");

  for (const command of ["docker", "sudo docker"]) {
    const result = await docker(["exec", "--user", "agent", name, "bash", "-c", `${command} info`], false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Docker support is off/);
    assert.match(result.stderr, /On — privileged/);
    assert.match(result.stderr, /Create a new workspace/);
    assert.match(result.stderr, /https:\/\/kintsugi.example\/workspace-templates\/test\/settings\?section=privileged/);
  }
  for (const unit of ["docker.socket", "docker.service", "containerd.service"]) {
    assert.equal(await exec("systemctl", "show", "--property=LoadState", "--value", unit), "masked");
    assert.notEqual((await docker(["exec", name, "systemctl", "start", unit], false)).exitCode, 0);
  }
  await exec("sh", "-ec", "test ! -S /run/docker.sock; test ! -S /run/containerd/containerd.sock");
  console.log("PASS: actionable CLI guidance for users and sudo; Docker/containerd cannot activate when disabled");

  await exec("sh", "-ec", "printf 'disabled\\n\\n' > /etc/kintsugi/docker-support");
  const projectless = await docker(["exec", name, "docker", "info"], false);
  assert.match(projectless.stderr, /create a workspace from a Workspace template/);
  await docker(["restart", "--time", "20", name]);
  await ready();
  assert.equal(await exec("systemctl", "show", "--property=LoadState", "--value", "docker.socket"), "masked");
  console.log("PASS: projectless guidance and disabled capability survive restart");
} finally {
  await docker(["rm", "-f", name, sibling]);
  await rm(directory, { recursive: true, force: true });
}
