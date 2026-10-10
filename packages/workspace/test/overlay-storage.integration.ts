// bun packages/workspace/test/overlay-storage.integration.ts LOCAL_WORKSPACE_IMAGE
// Disposable native runtime verification. Never targets an installed System.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@kintsugi/core";
import { createImagePreloader, defaultWorkspacePreload } from "../src/preload.ts";
import { transferImageArchive } from "../src/image-archive.ts";

const image = Bun.argv[2];
if (!image || Bun.argv.length !== 3) throw new Error("Pass a locally built workspace image");
const id = `kintsugi-overlay-${crypto.randomUUID().slice(0, 8)}`;
const producer = id + "-producer";
const consumer = id + "-consumer";
const directory = await mkdtemp(join(tmpdir(), id));
const containers: string[] = [];
const volumes: string[] = [];
let transferred = 0;
async function command(args: string[], stdin?: string | Uint8Array, check = true) {
  const result = await runCommand(args, { stdin });
  if (check && result.exitCode !== 0) throw new Error(`${args.slice(0, 5).join(" ")}: ${result.stderr}`);
  return result;
}
const exec = async (container: string, ...args: string[]) => (await command(["docker", "exec", "--user", "root", container, ...args])).stdout.toString().trim();
async function start(name: string, network: string) {
  const volume = name + "-data";
  volumes.push(volume);
  await command(["docker", "create", "--name", name, "--network", network, "--privileged", "--cgroupns=private", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3", "--mount", `source=${volume},target=/data`, image!]);
  containers.push(name);
  await command(["docker", "cp", directory + "/.", name + ":/etc/kintsugi"]);
  await command(["docker", "cp", join(directory, "token"), name + ":/etc/kintsugi-workspace-gateway-token"]);
  await command(["docker", "start", name]);
  for (let attempt = 0; ; attempt++) {
    if ((await command(["docker", "exec", name, "test", "-f", "/.kintsugi/ready"], undefined, false)).exitCode === 0) break;
    if (attempt >= 120) throw new Error("Workspace startup timed out");
    await Bun.sleep(500);
  }
  assert.equal(await exec(name, "systemctl", "is-active", "docker.socket"), "active");
}
try {
  await writeFile(join(directory, "token"), crypto.randomUUID());
  await writeFile(join(directory, "docker-support"), "enabled\n\n");
  await writeFile(join(directory, "storage.json"), '{"driver":"overlayfs"}\n');
  await start(producer, "bridge");
  await start(consumer, "none");
  await exec(producer, "systemctl", "start", "containerd.service");
  const docker = async (args: string[], options?: { stdin?: string | Uint8Array }) => {
    const cli = args[0] === "exec" ? ["docker", ...args] : ["docker", "exec", producer, "docker", ...args];
    const result = await command(cli, options?.stdin);
    return { ...result, stdout: result.stdout.toString() };
  };
  const run = (args: string[]) => command(["docker", "exec", producer, ...args]);
  const transfer = async (source: string[], destination: string[]) => {
    transferred++;
    await transferImageArchive(["docker", "exec", producer, ...source], destination);
  };
  const preloader = createImagePreloader(run, docker, undefined, undefined, undefined, async () => "overlayfs", transfer);
  const preloads = join(directory, "preloads");
  await preloader.snapshot(["alpine:3.22"], preloads);
  const images = await preloader.load(preloads);
  await preloader.install(images, consumer, console.log);
  assert.equal(await exec(consumer, "systemctl", "show", "--property=ActiveState", "--value", "docker.service"), "inactive", "preloading leaves Docker asleep");
  const pinned = (await exec(consumer, "ctr", "--namespace", "moby", "images", "ls", "-q")).split("\n").find(ref => /^docker.io\/library\/alpine@sha256:/.test(ref));
  assert(pinned);
  assert.equal(await exec(consumer, "docker", "info", "--format", "{{.Driver}}"), "overlayfs");
  assert.equal(await exec(consumer, "docker", "run", "--rm", "--network=none", pinned, "echo", "offline-run-ok"), "offline-run-ok");
  const dockerfile = `FROM docker.io/library/alpine:3.22@${pinned.split("@")[1]}\nRUN --mount=type=cache,target=/cache echo cached > /cache/marker && echo offline-build-ok > /marker\nCMD ["cat", "/marker"]\n`;
  await command(["docker", "exec", "-i", consumer, "docker", "build", "--builder", "default", "--network=none", "--output", "type=image,store-allow-incomplete=true", "-t", "overlay-test:derived", "-"], dockerfile);
  assert.equal(await exec(consumer, "docker", "run", "--rm", "--network=none", "overlay-test:derived"), "offline-build-ok");
  await preloader.install(images, consumer, console.log);
  assert.equal(transferred, 2, "warm image reuse performs no archive transfer");

  // A locally built image must also transfer without accessing a registry.
  await command(["docker", "exec", "-i", producer, "docker", "build", "--network=none", "-t", "local-overlay:default", "-"], `FROM alpine:3.22\nRUN echo local-image-ok > /local-marker\n`);
  const local = createImagePreloader(run, docker, undefined, async () => "local-overlay:default", undefined, async () => "overlayfs", transfer);
  const localPath = join(directory, "local-preloads");
  await local.snapshot([defaultWorkspacePreload], localPath);
  const localImages = await local.load(localPath);
  await local.install(localImages, consumer, console.log);
  const localRef = await exec(consumer, "cat", "/etc/kintsugi/default-workspace-image");
  assert.match(localRef, /^docker.io\/library\/local-overlay:default@sha256:/);
  assert.equal(await exec(consumer, "docker", "run", "--rm", "--network=none", localRef, "cat", "/local-marker"), "local-image-ok");
  await command(["docker", "restart", "--time", "30", consumer]);
  for (let attempt = 0; ; attempt++) {
    const result = await command(["docker", "exec", consumer, "test", "-f", "/.kintsugi/ready"], undefined, false);
    if (result.exitCode === 0) break;
    if (attempt >= 120) throw new Error("Restart timed out");
    await Bun.sleep(500);
  }
  await local.install(localImages, consumer, console.log);
  assert.equal(transferred, 4, "restart reuses both complete images");
  assert.equal(await exec(consumer, "docker", "run", "--rm", "--network=none", "overlay-test:derived"), "offline-build-ok");
  console.log("PASS: OverlayFS daemon, native archive, offline run/build/cache mount, local image, warm reuse and restart");
} catch (error) {
  for (const container of containers) console.error((await command(["docker", "exec", container, "ctr", "--namespace", "moby", "images", "ls"], undefined, false)).stdout.toString());
  for (const container of containers) console.error((await command(["docker", "exec", container, "journalctl", "--no-pager", "-n", "60"], undefined, false)).stdout.toString());
  throw error;
} finally {
  for (const name of containers.reverse()) await command(["docker", "rm", "--force", name]);
  for (const volume of volumes.reverse()) await command(["docker", "volume", "rm", volume]);
  await rm(directory, { recursive: true, force: true });
}
