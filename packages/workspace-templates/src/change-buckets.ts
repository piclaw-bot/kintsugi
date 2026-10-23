import { invalidArguments } from "@kintsugi/core";
import { findConfigurationRecord, isGlobalScope, readWorkspaceTemplateStore, updateWorkspaceTemplateStore, workspaceScopes, workspaceTemplatesFile, type ConfigurationRecord, type ConfigurationScope } from "./workspace-template.ts";

/** A named group of changed files, like Tests. Files matching no bucket are the main work. */
export interface ChangeBucket { name: string; patterns: string[] }

/** Used while the global settings have never saved their own buckets. */
export const defaultChangeBuckets = `Tests: *{Test,Tests,Spec}.* *{.,_,-}{test,tests,spec}.* test_* {test,tests,Tests,__tests__,spec}/
Evals: *{Eval,Evals}.* *{.,_,-}{eval,evals}.* {eval,evals,Evals}/
`;

/** One bucket per line: `Name: pattern pattern !pattern`. Blank lines and lines starting with # are ignored. */
export function parseChangeBuckets(text: string): ChangeBucket[] {
  const buckets: ChangeBucket[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    const name = line.slice(0, separator).trim();
    if (separator < 0 || !name) throw invalidArguments(`Start each line with a bucket name and a colon, like “Tests: *.test.*” (not “${line}”)`);
    if (name.length > 40) throw invalidArguments(`“${name}” is too long for a bucket name`);
    if (buckets.some(bucket => bucket.name.toLowerCase() === name.toLowerCase())) throw invalidArguments(`There’s more than one bucket called “${name}”`);
    const patterns = line.slice(separator + 1).trim().split(/\s+/).filter(Boolean);
    for (const pattern of patterns) if (pattern === "!" || pattern === "/" || pattern === "!/") throw invalidArguments(`“${pattern}” in ${name} doesn’t match any files`);
    buckets.push({ name, patterns });
  }
  return buckets;
}

function storedChangeBuckets(scope: ConfigurationScope, configuration: ConfigurationRecord): string {
  return configuration.changeBuckets ?? (isGlobalScope(scope) ? defaultChangeBuckets : "");
}

/** Saved text for the scope. A template's empty text removes its own buckets; global empty text means no buckets at all. */
export async function setChangeBuckets(scope: ConfigurationScope, text: string, file = workspaceTemplatesFile()): Promise<string> {
  parseChangeBuckets(text);
  return await updateWorkspaceTemplateStore(file, (store) => {
    const configuration = findConfigurationRecord(store, scope);
    if (text.trim() || isGlobalScope(scope)) configuration.changeBuckets = text;
    else delete configuration.changeBuckets;
    return storedChangeBuckets(scope, configuration);
  });
}

export async function getChangeBuckets(scope: ConfigurationScope, file = workspaceTemplatesFile()): Promise<string> {
  return storedChangeBuckets(scope, findConfigurationRecord(await readWorkspaceTemplateStore(file), scope));
}

/** Global buckets in order; a template's bucket replaces the global one with the same name, and its others follow. */
export async function effectiveChangeBuckets(workspaceTemplateId?: string, file = workspaceTemplatesFile()): Promise<ChangeBucket[]> {
  const store = await readWorkspaceTemplateStore(file);
  const buckets: ChangeBucket[] = [];
  for (const scope of workspaceScopes(workspaceTemplateId)) for (const bucket of parseChangeBuckets(storedChangeBuckets(scope, findConfigurationRecord(store, scope)))) {
    const existing = buckets.findIndex(candidate => candidate.name.toLowerCase() === bucket.name.toLowerCase());
    if (existing < 0) buckets.push(bucket);
    else buckets[existing] = bucket;
  }
  // A template disables a shared bucket by naming it without patterns.
  return buckets.filter(bucket => bucket.patterns.some(pattern => !pattern.startsWith("!")));
}
