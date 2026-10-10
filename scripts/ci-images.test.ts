import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestValue, sliceReferences, verifiedImage } from "./ci-images.ts";
import type { Run } from "./release-support.ts";

const digest = `sha256:${"a".repeat(64)}`;
const amd64 = `sha256:${"b".repeat(64)}`;
const arm64 = `sha256:${"c".repeat(64)}`;
const image = "ghcr.io/example/kintsugi";
const workspace = `ghcr.io/example/kintsugi-workspace@${digest}`;
const label = "org.opencontainers.image.revision";
const commit = "d".repeat(40);
const manifest = () => ({ digest, manifests: [
  { digest: amd64, platform: { os: "linux", architecture: "amd64" } },
  { digest: arm64, platform: { os: "linux", architecture: "arm64" } },
] });
function runner(options: { missing?: string; modifyManifest?: (value: ReturnType<typeof manifest>) => void; modifyConfig?: (value: { os: string; architecture: string; config: { Labels: Record<string, string> } }) => void } = {}): Run {
  return async args => {
    if (options.missing) return { code: 1, stdout: "", stderr: options.missing };
    if (args.at(-1) === "{{json .Manifest}}") {
      const value = manifest(); options.modifyManifest?.(value);
      return { code: 0, stdout: JSON.stringify(value), stderr: "" };
    }
    const value = { os: "linux", architecture: args.includes(`${image}@${amd64}`) ? "amd64" : "arm64", config: { Labels: {
      [label]: commit,
      "eagerly-preload": JSON.stringify([workspace]),
      "com.kintsugi.workspace-image.ref": workspace,
      "com.kintsugi.system.signature": "signature",
      "kintsugi.installer-config": "1",
    } } };
    options.modifyConfig?.(value);
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  };
}

test("digest receipts reject malformed or injected values", () => {
  expect(digestValue(digest)).toBe(digest);
  for (const value of ["latest", digest + "\n--tag latest", "sha256:abc", ""]) expect(() => digestValue(value)).toThrow();
});
test("merge requires exactly one receipt per native architecture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ci-image-receipts-"));
  try {
    await writeFile(join(directory, "amd64"), amd64);
    expect(() => sliceReferences(directory, image)).toThrow();
    await writeFile(join(directory, "arm64"), arm64);
    expect(sliceReferences(directory, image)).toEqual([`${image}@${amd64}`, `${image}@${arm64}`]);
    await writeFile(join(directory, "extra"), digest);
    expect(() => sliceReferences(directory, image)).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("verified app requires both native slices and pinned multiarch dependency", async () => {
  expect(await verifiedImage(runner(), `${image}:sha-${commit}`, label, commit)).toBe(`${image}@${digest}`);
});
test("only explicit missing manifests are reusable cache misses", async () => {
  expect(await verifiedImage(runner({ missing: "manifest unknown" }), image, label, commit, true)).toBeUndefined();
  for (const missing of ["unauthorized", "denied", "connection refused", "HTTP 500"])
    await expect(verifiedImage(runner({ missing }), image, label, commit, true)).rejects.toThrow("Cannot inspect");
});
test("required manifests never accept absence", async () => {
  await expect(verifiedImage(runner({ missing: "manifest unknown" }), image, label, commit)).rejects.toThrow();
});
test("partial, duplicate and invalid manifests fail closed", async () => {
  for (const modifyManifest of [
    (value: ReturnType<typeof manifest>) => { value.manifests.pop(); },
    (value: ReturnType<typeof manifest>) => { value.manifests[1]!.platform.architecture = "amd64"; },
    (value: ReturnType<typeof manifest>) => { value.digest = "bad"; },
    (value: ReturnType<typeof manifest>) => { value.manifests[0]!.digest = "bad"; },
  ]) await expect(verifiedImage(runner({ modifyManifest }), image, label, commit, true)).rejects.toThrow();
});
test("wrong source revision cannot be reused", async () => {
  await expect(verifiedImage(runner({ modifyConfig: value => { value.config.Labels[label] = "wrong"; } }), image, label, commit, true)).rejects.toThrow("does not match");
});
test("wrong native architecture cannot pass verification", async () => {
  await expect(verifiedImage(runner({ modifyConfig: value => { value.architecture = "arm64"; } }), image, label, commit)).rejects.toThrow("does not match");
});
test("mutable or inconsistent workspace dependencies fail", async () => {
  for (const dependency of ["ghcr.io/example/workspace:latest", `${image}@${digest}`])
    await expect(verifiedImage(runner({ modifyConfig: value => { value.config.Labels["eagerly-preload"] = JSON.stringify([dependency]); } }), image, label, commit)).rejects.toThrow();
});
test("System reuse requires the installer capability", async () => {
  await expect(verifiedImage(runner({ modifyConfig: value => { value.config.Labels["kintsugi.installer-config"] = "0"; } }), image, "com.kintsugi.system.signature", "signature")).rejects.toThrow("installer capability");
});
