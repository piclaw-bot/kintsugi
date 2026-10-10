import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { kintsugiDataPath, createProcessFileLock, dockerHostKintsugiDataPath, getKintsugiRuntimeContext, requireDocker } from "@kintsugi/core";
import { ensureDefaultWorkspaceImage } from "@kintsugi/workspace-image";
import type { WorkspaceDockerMount } from "./types.ts";

const withHomeLock = createProcessFileLock({
  lockDir: () => kintsugiDataPath(getKintsugiRuntimeContext(), "home.lock"),
  label: "shared home initialization",
});

/** Publish a complete home once; deleted defaults are never restored on later starts. */
export async function ensureSharedHome(): Promise<void> {
  const runtime = getKintsugiRuntimeContext();
  const home = kintsugiDataPath(runtime, "home");
  if (existsSync(home)) return;
  // Image acquisition can take minutes; don't hold the short-lived filesystem lock.
  const image = await ensureDefaultWorkspaceImage();
  await withHomeLock(async () => {
    if (existsSync(home)) return;
    const staging = await mkdtemp(kintsugiDataPath(runtime, ".home-seed-"));
    const container = `kintsugi-home-seed-${crypto.randomUUID()}`;
    try {
      await requireDocker(["create", "--name", container, "--entrypoint", "/bin/true", image]);
      try {
        // docker cp assigns files to the invoking host user, rather than the image UID.
        await requireDocker(["cp", `${container}:/opt/kintsugi/home-defaults/.`, staging]);
      } finally {
        await requireDocker(["rm", container]);
      }
      await chmod(staging, 0o700);
      await rename(staging, home);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

export async function workspaceHomeMounts(workspaceId: string): Promise<WorkspaceDockerMount[]> {
  await ensureSharedHome();
  const runtime = getKintsugiRuntimeContext();
  const mounts: WorkspaceDockerMount[] = [{ type: "bind", source: dockerHostKintsugiDataPath(runtime, "home"), target: "/home/agent" }];
  for (const path of [".local/share", ".local/state", ".cache"]) {
    // Pre-create mountpoints as the host user, not as Docker's root user.
    await mkdir(kintsugiDataPath(runtime, "home", path), { recursive: true });
    await mkdir(kintsugiDataPath(runtime, "workspaces", workspaceId, "home-local", path), { recursive: true, mode: 0o700 });
    mounts.push({ type: "bind", source: dockerHostKintsugiDataPath(runtime, "workspaces", workspaceId, "home-local", path), target: `/home/agent/${path}` });
  }
  return mounts;
}
