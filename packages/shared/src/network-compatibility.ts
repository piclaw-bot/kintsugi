import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isNotFoundError } from "@kintsugi/core";
import { networkModeSchema, networkPolicySchema } from "./network-policy.ts";
import { parseSystemVersion, systemVersionLabel, networkPolicyVersionLabel } from "./system-version.ts";

const stateSchema = Type.Object({ mode: Type.Optional(networkModeSchema), applied: Type.Optional(networkPolicySchema) });
const policiesSchema = Type.Record(Type.String(), networkPolicySchema);
async function directories(path: string): Promise<string[]> { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
async function text(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); } catch (error) { if (isNotFoundError(error)) return undefined; throw error; }
}

/** Image rollback leaves settings intact. Refuse a downgrade while a newer policy format is desired/applied. */
export async function requiredNetworkStateVersion(systemData: string, appData = join(systemData, "app")): Promise<number> {
  const policies = await text(join(systemData, "supervisor", "workspace-networks.json"));
  if (policies !== undefined) {
    const parsed = Value.Parse(policiesSchema, JSON.parse(policies));
    if (Object.values(parsed).some(policy => policy.mode === "hosts")) return 2;
  }
  return requiredAppNetworkStateVersion(appData);
}

/** App-owned desired/applied state; does not read privileged supervisor configuration. */
export async function requiredAppNetworkStateVersion(appData: string): Promise<number> {
  let workspaces: Awaited<ReturnType<typeof directories>>;
  try { workspaces = await directories(join(appData, "workspaces")); }
  catch (error) { if (isNotFoundError(error)) return 0; throw error; }
  for (const id of workspaces) {
    const saved = await text(join(appData, "workspaces", id, "metadata", "network.json"));
    if (saved === undefined) continue;
    const state = Value.Parse(stateSchema, JSON.parse(saved));
    if (state.mode === "hosts" || state.applied?.mode === "hosts") return 2;
  }
  return 0;
}

export function assertNetworkStateCompatible(required: number, appLabels: Readonly<Record<string, string>> | null | undefined, systemLabels: Readonly<Record<string, string>> | null | undefined): void {
  if (parseSystemVersion(systemLabels?.[systemVersionLabel]) < required || parseSystemVersion(appLabels?.[networkPolicyVersionLabel]) < required) throw new Error("Listed-host settings require compatible app and installation images. Turn off listed-host access and apply Off to every affected workspace before downgrading. Saved data was not changed.");
}
