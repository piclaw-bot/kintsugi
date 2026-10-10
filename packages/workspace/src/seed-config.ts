import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KintsugiCoreError, kintsugiDataPath, type KintsugiRuntimeContext } from "@kintsugi/core";
import type { RepoWorkspaceManifest } from "./index.ts";
import type { WorkspaceDockerPlan } from "./types.ts";
import { seedConfigInstallScript } from "./startup-scripts.ts";

export async function applySeedConfigManifest(manifest: RepoWorkspaceManifest, plan: WorkspaceDockerPlan, runtime: KintsugiRuntimeContext, seedDirectory: string): Promise<void> {
  if ((manifest.seedPiConfig || manifest.seedKintsugiConfig) && !plan.seedConfigEnabled) {
    throw new KintsugiCoreError("workspace_seed_config_disabled", "This repository requests Atelier-in-Atelier seeding. Enable it in the workspace template’s Developer Settings (hold Alt in template settings), then create a new workspace.");
  }
  const entries: Array<{ source: string; staging: string; target: string }> = [];
  for (const [name, target] of [
    ["auth", manifest.seedPiConfig?.authJson],
    ["models", manifest.seedPiConfig?.modelsJson],
    ["models-store", manifest.seedPiConfig?.modelsStoreJson],
  ] as const) {
    if (target) entries.push({ source: kintsugiDataPath(runtime, "pi-config", `${name}.json`), staging: `/.kintsugi/seed-pi-${name}.json`, target });
  }
  // The repository manifest key and filenames retain their persisted spelling.
  const workspaceTemplatesJson = manifest.seedKintsugiConfig?.projectsJson;
  if (workspaceTemplatesJson) {
    // Sanitize on the host: neither encrypted credentials nor the master key may
    // cross into the agent workspace, even as temporary staging files.
    const catalogue = JSON.parse(await readFile(kintsugiDataPath(runtime, "projects.json"), "utf8"));
    const sanitized = JSON.stringify(catalogue, (key, value) =>
      key === "encryptedSecret" || key === "encryptedPrivateKey" || key === "sshKeys" ? undefined : value,
    );
    await mkdir(seedDirectory, { recursive: true });
    const source = join(seedDirectory, "projects.json");
    await writeFile(source, `${sanitized}\n`, { mode: 0o600 });
    entries.push({ source, staging: "/.kintsugi/seed-projects.json", target: workspaceTemplatesJson });
  }
  for (const entry of entries) {
    plan.containerFiles.push({ source: entry.source, target: entry.staging });
    plan.initScripts.push(seedConfigInstallScript(entry.staging, entry.target));
  }
}

