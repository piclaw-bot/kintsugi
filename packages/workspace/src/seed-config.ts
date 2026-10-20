import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KintsugiCoreError, isJsonObject, kintsugiDataPath, type KintsugiRuntimeContext, type JsonObject } from "@kintsugi/core";
import type { RepoWorkspaceManifest } from "./index.ts";
import type { WorkspaceDockerPlan } from "./types.ts";
import { seedConfigInstallScript } from "./startup-scripts.ts";

let seededPiAuth: ((auth: JsonObject) => JsonObject) | undefined;

/** Rewrites the host's Pi credentials before they are copied into a workspace. */
export function registerSeededPiAuth(transform: (auth: JsonObject) => JsonObject): void {
  seededPiAuth = transform;
}

export async function applySeedConfigManifest(manifest: RepoWorkspaceManifest, plan: WorkspaceDockerPlan, runtime: KintsugiRuntimeContext, seedDirectory: string): Promise<void> {
  if ((manifest.seedPiConfig || manifest.seedKintsugiConfig) && !plan.seedConfigEnabled) {
    throw new KintsugiCoreError("workspace_seed_config_disabled", "This repository requests Kintsugi-in-Kintsugi seeding. Enable it in the workspace template’s Developer Settings (hold Alt in template settings), then create a new workspace.");
  }
  const entries: Array<{ source: string; staging: string; target: string }> = [];
  const authJson = manifest.seedPiConfig?.authJson;
  if (authJson) {
    if (!seededPiAuth) throw new Error("Pi auth seeding is not registered");
    const stored: unknown = JSON.parse(await readFile(kintsugiDataPath(runtime, "pi-config", "auth.json"), "utf8"));
    if (!isJsonObject(stored)) throw new Error("Pi auth must be a JSON object");
    const auth = seededPiAuth(stored);
    entries.push({ source: await writeSeedFile(seedDirectory, "auth.json", JSON.stringify(auth)), staging: "/.kintsugi/seed-pi-auth.json", target: authJson });
  }
  for (const [name, target] of [
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
      key === "credentials" || key === "credentialAudit" || key === "encryptedSecret" || key === "encryptedPrivateKey" || key === "sshKeys" ? undefined : value,
    );
    entries.push({ source: await writeSeedFile(seedDirectory, "projects.json", sanitized), staging: "/.kintsugi/seed-projects.json", target: workspaceTemplatesJson });
  }
  for (const entry of entries) {
    plan.containerFiles.push({ source: entry.source, target: entry.staging });
    plan.initScripts.push(seedConfigInstallScript(entry.staging, entry.target));
  }
}

async function writeSeedFile(seedDirectory: string, name: string, json: string): Promise<string> {
  await mkdir(seedDirectory, { recursive: true });
  const path = join(seedDirectory, name);
  await writeFile(path, `${json}\n`, { mode: 0o600 });
  return path;
}
