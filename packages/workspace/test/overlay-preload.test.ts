import { expect, test } from "bun:test";
import { createImagePreloader, defaultWorkspacePreload } from "../src/preload.ts";
import type { CommandResult } from "@kintsugi/core";

const indexDigest = `sha256:${"a".repeat(64)}`;
const nativeDigest = `sha256:${"b".repeat(64)}`;
const otherDigest = `sha256:${"c".repeat(64)}`;
const image = `docker.io/library/example:1@${indexDigest}`;
const installedReference = `docker.io/library/example@${nativeDigest}`;

function fixture(architecture: "amd64" | "arm64") {
  let installed = false;
  let importFails = false;
  let native = true;
  let corrupt = false;
  const calls: string[][] = [];
  const transfers: { source: string[]; destination: string[] }[] = [];
  const refs: string[] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args.slice(3, 5).join(" ") !== "content get") throw new Error("EROFS helper must not execute");
    const value = args.at(-1) === indexDigest
      ? { manifests: [{ digest: native ? nativeDigest : otherDigest, platform: { os: "linux", architecture: native ? architecture : architecture === "amd64" ? "arm64" : "amd64" } }] }
      : { layers: [{ digest: otherDigest }], config: { digest: otherDigest } };
    return { stdout: Buffer.from(JSON.stringify(value)), stderr: "" };
  };
  const docker = async (args: string[], options?: { stdin?: string | Uint8Array }): Promise<CommandResult> => {
    calls.push(["docker", ...args]);
    if (args[0] === "version") return { exitCode: 0, stdout: `linux/${architecture}\n`, stderr: "" };
    if (args.includes("tee")) refs.push(String(options?.stdin));
    const stdout = args.includes("ls") && installed
      ? `REF TYPE DIGEST SIZE PLATFORMS LABELS\n${installedReference} manifest ${corrupt ? otherDigest : nativeDigest} 1B linux/${architecture} -\n`
      : "";
    return { exitCode: 0, stdout, stderr: "" };
  };
  const transfer = async (source: string[], destination: string[]) => {
    transfers.push({ source, destination });
    if (importFails) throw new Error("archive import failed");
    installed = true;
  };
  const preloader = createImagePreloader(run, docker, undefined, undefined, async () => { throw new Error("EROFS cache must not build"); }, async () => "overlayfs", transfer);
  return { preloader, calls, transfers, refs, fail: () => { importFails = true; }, missingNative: () => { native = false; }, corrupt: () => { corrupt = true; } };
}

test.each(["amd64", "arm64"] as const)("overlayfs (%s) streams complete native archives, registers and pins the native manifest and reuses warm images", async (architecture) => {
  const f = fixture(architecture);
  const images = [{ requested: defaultWorkspacePreload, reference: image }];
  await f.preloader.install(images, "workspace");
  await f.preloader.install(images, "workspace");
  expect(f.transfers).toHaveLength(2);
  expect(f.transfers[0]!.source).toEqual(["ctr", "--namespace", "moby", "images", "export", "--local", "--platform", `linux/${architecture}`, "--skip-manifest-json", "-", image]);
  expect(f.transfers[0]!.destination).toContain("overlayfs");
  expect(f.transfers[0]!.destination).toContain("--digests");
  expect(f.refs).toEqual([`docker.io/library/example:1@${nativeDigest}\n`, `docker.io/library/example:1@${nativeDigest}\n`]);
  expect(f.calls.some(args => args.includes("docker.service"))).toBe(false);
});

test.each(["amd64", "arm64"] as const)("overlayfs (%s) never publishes default FROM after transfer failure or digest mismatch", async (architecture) => {
  const f = fixture(architecture); f.fail();
  await expect(f.preloader.install([{ requested: defaultWorkspacePreload, reference: image }], "workspace")).rejects.toThrow("archive import failed");
  expect(f.refs).toEqual([]);
  const bad = fixture(architecture); bad.corrupt();
  await expect(bad.preloader.install([{ requested: defaultWorkspacePreload, reference: image }], "workspace")).rejects.toThrow("Transferred image digest mismatch");
  expect(bad.refs).toEqual([]);
});

test.each(["amd64", "arm64"] as const)("overlayfs (%s) rejects missing native manifests and unresolved preloads without transferring", async (architecture) => {
  const f = fixture(architecture); f.missingNative();
  await expect(f.preloader.install([{ requested: "example", reference: image }], "workspace")).rejects.toThrow("unique native manifest");
  await expect(f.preloader.install([{ requested: "example" }], "workspace")).rejects.toThrow("not been resolved");
  expect(f.transfers).toEqual([]);
});
