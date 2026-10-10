import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "./release-support.ts";

const platforms = ["linux/amd64", "linux/arm64"];

async function inspectImage(run: Run, ref: string, optional = false) {
  const result = await run(["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"], { allowFailure: optional });
  if (result.code !== 0) {
    if (optional && /manifest unknown|: not found\b/i.test(result.stderr)) return undefined;
    throw new Error(`Cannot inspect ${ref}: ${result.stderr}`);
  }
  const manifest: { digest: string; manifests: { digest: string; platform: { os: string; architecture: string } }[] } = JSON.parse(result.stdout);
  digestValue(manifest.digest);
  if (!Array.isArray(manifest.manifests) || manifest.manifests.length !== 2) throw new Error(`${ref}: expected two native slices`);
  for (const platform of platforms) {
    const slices = manifest.manifests.filter(entry => `${entry.platform.os}/${entry.platform.architecture}` === platform);
    if (slices.length !== 1) throw new Error(`${ref}: missing or duplicate ${platform}`);
    digestValue(slices[0]!.digest);
  }
  return manifest;
}

export function digestValue(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("Invalid image digest");
  return value;
}

export function sliceReferences(directory: string, image: string): string[] {
  const files = readdirSync(directory).sort();
  if (files.join(",") !== "amd64,arm64") throw new Error("Expected exactly one AMD64 and one ARM64 receipt");
  return files.map(file => `${image}@${digestValue(readFileSync(join(directory, file), "utf8").trim())}`);
}

export async function verifiedImage(run: Run, ref: string, label: string, expected: string, optional = false): Promise<string | undefined> {
  const manifest = await inspectImage(run, ref, optional);
  if (!manifest) return undefined;
  const repository = ref.split("@")[0]!.replace(/:[^/:]+$/, "");
  for (const platform of platforms) {
    const slice = manifest.manifests.find(entry => `${entry.platform.os}/${entry.platform.architecture}` === platform)!;
    const result = await run(["docker", "buildx", "imagetools", "inspect", `${repository}@${slice.digest}`, "--format", "{{json .Image}}"]);
    const config = JSON.parse(result.stdout);
    if (`${config.os}/${config.architecture}` !== platform || config.config?.Labels?.[label] !== expected)
      throw new Error(`${ref}: ${platform} label ${label} does not match ${expected}`);
    if (label === "com.kintsugi.system.signature" && config.config.Labels["kintsugi.installer-config"] !== "1")
      throw new Error(`${ref}: missing installer capability`);
    if (label === "org.opencontainers.image.revision") {
      const dependencies = JSON.parse(config.config.Labels["eagerly-preload"] ?? "[]");
      if (dependencies.length !== 1 || dependencies[0] !== config.config.Labels["com.kintsugi.workspace-image.ref"])
        throw new Error(`${ref}: workspace dependency mismatch`);
      if (!/@sha256:[a-f0-9]{64}$/.test(dependencies[0])) throw new Error(`${ref}: unpinned workspace dependency`);
      await inspectImage(run, dependencies[0]);
    }
  }
  return `${repository}@${digestValue(manifest.digest)}`;
}

export async function channelMatches(run: Run, ref: string): Promise<boolean> {
  const [repository, digest] = ref.split("@");
  digestValue(digest ?? "");
  const manifest = await inspectImage(run, `${repository}:latest`, true);
  return manifest?.digest === digest;
}

if (import.meta.main) {
  const run: Run = async (args, options) => {
    const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (code && !options?.allowFailure) throw new Error(`${args.slice(0, 4).join(" ")}: ${stderr}`);
    return { stdout, stderr, code };
  };
  const [command, ...args] = process.argv.slice(2);
  if (command === "reuse" || command === "verify") {
    if (args.length !== 3) throw new Error("Usage: ci-images.ts reuse|verify REF LABEL VALUE");
    const ref = await verifiedImage(run, args[0]!, args[1]!, args[2]!, command === "reuse");
    console.log(`exists=${Boolean(ref)}`);
    console.log(`ref=${ref ?? ""}`);
  } else if (command === "current") {
    if (args.length !== 1) throw new Error("Usage: ci-images.ts current PINNED_REF");
    console.log(`matches=${await channelMatches(run, args[0]!)}`);
  } else if (command === "merge") {
    if (args.length !== 3) throw new Error("Usage: ci-images.ts merge RECEIPTS IMAGE TAG");
    await run(["docker", "buildx", "imagetools", "create", "--tag", `${args[1]}:${args[2]}`, ...sliceReferences(args[0]!, args[1]!)]);
  } else throw new Error("Unknown CI image command");
}
