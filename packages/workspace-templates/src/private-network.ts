import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { acquireFileLock, getKintsugiRuntimeContext, isNotFoundError, writeJsonAtomic } from "@kintsugi/core";
import { formatPrivateNetworkDestination, parsePrivateNetworkDestination, parsePrivateNetworkDestinations, type PrivateNetworkDestination } from "@kintsugi/shared/network-destinations";
import { findWorkspaceTemplateRecord, isGlobalScope, readWorkspaceTemplateStore, workspaceScopes, workspaceTemplatesFile, type ConfigurationScope } from "./workspace-template.ts";

const entriesSchema = Type.Array(Type.String({ maxLength: 300 }), { maxItems: 128 });
const storeSchema = Type.Object({ global: entriesSchema, templates: Type.Record(Type.String({ pattern: "^template:[^\\r\\n]+$", maxLength: 265 }), entriesSchema) }, { additionalProperties: false });
type PrivateNetworkStore = import("typebox").Static<typeof storeSchema>;
export const privateNetworkSettingsPath = () => join(getKintsugiRuntimeContext().kintsugiDataDir, "private-network-destinations.json");

async function readStore(file: string): Promise<PrivateNetworkStore> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) { if (isNotFoundError(error)) return { global: [], templates: {} }; throw error; }
  const store = Value.Parse(storeSchema, JSON.parse(text));
  // Validate semantic syntax too; a malformed saved file must never become a permission.
  store.global = canonicalEntries(store.global.join("\n"));
  for (const key of Object.keys(store.templates)) store.templates[key] = canonicalEntries(store.templates[key]!.join("\n"));
  return store;
}
function canonicalEntries(input: string): string[] { return parsePrivateNetworkDestinations(input).map(formatPrivateNetworkDestination); }
async function validateScope(scope: ConfigurationScope, templatesFile: string): Promise<void> {
  if (!isGlobalScope(scope)) findWorkspaceTemplateRecord(await readWorkspaceTemplateStore(templatesFile), scope);
}
function entriesFor(store: PrivateNetworkStore, scope: ConfigurationScope): string[] {
  return isGlobalScope(scope) ? store.global : store.templates[`template:${scope}`] ?? [];
}

/** Lists are private security configuration, separate from discovery summaries and legacy template files. */
export async function getPrivateNetworkAccess(scope: ConfigurationScope, file = privateNetworkSettingsPath(), templatesFile = workspaceTemplatesFile()): Promise<string[]> {
  await validateScope(scope, templatesFile);
  return [...entriesFor(await readStore(file), scope)];
}

/** Saving alone grants nothing. The runtime consumes a list only in an explicitly enabled mode. */
export async function setPrivateNetworkAccess(scope: ConfigurationScope, input: string, file = privateNetworkSettingsPath(), templatesFile = workspaceTemplatesFile()): Promise<string[]> {
  const entries = canonicalEntries(input);
  await validateScope(scope, templatesFile);
  const release = await acquireFileLock(file + ".lock", "private network settings");
  try {
    const store = await readStore(file);
    if (isGlobalScope(scope)) store.global = entries;
    else if (entries.length) store.templates[`template:${scope}`] = entries;
    else delete store.templates[`template:${scope}`];
    await writeJsonAtomic(file, store, { mode: 0o600 });
    return [...entries];
  } finally { await release(); }
}

/** Global entries plus the template's entries; no CIDR, DNS or mode settings are changed. */
export async function effectivePrivateNetworkAccess(templateId?: string, file = privateNetworkSettingsPath(), templatesFile = workspaceTemplatesFile()): Promise<PrivateNetworkDestination[]> {
  if (templateId !== undefined) await validateScope(templateId, templatesFile);
  const store = await readStore(file);
  const entries = [...new Set(workspaceScopes(templateId).flatMap(scope => entriesFor(store, scope)))];
  return entries.map(parsePrivateNetworkDestination);
}
