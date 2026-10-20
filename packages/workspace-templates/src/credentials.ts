import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { invalidArguments, type JsonValue } from "@kintsugi/core";
import { encryptWorkspaceTemplateValue, decryptWorkspaceTemplateValue } from "./secret-crypto.ts";
import { readWorkspaceTemplateStore, updateWorkspaceTemplateStore, workspaceTemplatesFile, findWorkspaceTemplateRecord, type WorkspaceTemplateStore } from "./workspace-template.ts";
import { instanceCredentialInputSchema, type InstanceCredentialInput, type InstanceCredentialSummary, type StoredInstanceCredential } from "./credentials-schema.ts";

export { instanceCredentialInputSchema, type InstanceCredentialInput, type InstanceCredentialSummary } from "./credentials-schema.ts";
const encryptionScope = "instance-credentials";
export function credentialPlaceholder(id: string): string { return `KINTSUGI_CREDENTIAL_${id.replaceAll("-", "")}`; }
export function credentialHosts(credential: Pick<InstanceCredentialSummary, "hostPattern">): string[] { return credential.hostPattern.split(","); }
function summary({ encryptedSecret: _, ...metadata }: StoredInstanceCredential): InstanceCredentialSummary { return metadata; }
function find(store: WorkspaceTemplateStore, id: string): StoredInstanceCredential {
  const credential = store.credentials?.find(item => item.id === id);
  if (!credential) throw invalidArguments("Credential not found");
  return credential;
}
function audit(store: WorkspaceTemplateStore, id: string, action: "created" | "updated" | "rotated" | "deleted") {
  store.credentialAudit = [...(store.credentialAudit ?? []), { credentialId: id, action, at: new Date().toISOString() }].slice(-1000);
}
export function parseInstanceCredentialInput(value: JsonValue): InstanceCredentialInput {
  if (!Value.Check(instanceCredentialInputSchema, value)) throw invalidArguments("Invalid credential fields");
  return value;
}
function normalize(input: InstanceCredentialInput): InstanceCredentialInput {
  if (!Value.Check(instanceCredentialInputSchema, input)) throw invalidArguments("Provide a name, variable, type, description, exact hosts, path permission, enabled state and template grants");
  const name = input.name.trim();
  if (!name) throw invalidArguments("Credential name is required");
  const hosts = [...new Set(input.hostPattern.split(/[,;\s]+/).filter(Boolean).map(host => host.toLowerCase()))];
  // Exact DNS hosts only. No scheme, wildcard, userinfo, port or URL path.
  if (!hosts.length || hosts.some(host => host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host))) throw invalidArguments("Use exact DNS hosts, such as api.github.com. Credentials are sent over HTTPS on port 443 only.");
  return { ...input, name, description: input.description.trim(), hostPattern: hosts.join(",") };
}
function validateGrants(store: WorkspaceTemplateStore, input: InstanceCredentialInput, id: string) {
  if (store.credentials?.some(item => item.id !== id && item.name.toLowerCase() === input.name.toLowerCase())) throw invalidArguments("A credential with this name already exists");
  for (const templateId of input.templateIds) {
    const template = findWorkspaceTemplateRecord(store, templateId);
    if ([...(store.global.environment ?? []), ...(template.environment ?? [])].some(variable => variable.name === input.envName)) throw invalidArguments(`The variable ${input.envName} is already an environment variable for ${template.name}`);
    if ([...(store.global.secrets ?? []), ...(template.secrets ?? [])].some(secret => secret.envName === input.envName)) throw invalidArguments(`The variable ${input.envName} is already a legacy secret for ${template.name}; use a different variable`);
    if (store.credentials?.some(item => item.id !== id && item.envName === input.envName && item.templateIds.includes(templateId))) throw invalidArguments(`Another credential already uses ${input.envName} for ${template.name}`);
  }
}
export async function listInstanceCredentials(file = workspaceTemplatesFile()) {
  const store = await readWorkspaceTemplateStore(file);
  return { credentials: (store.credentials ?? []).map(summary).sort((a, b) => a.name.localeCompare(b.name)), audit: store.credentialAudit ?? [] };
}
export async function saveInstanceCredential(id: string | undefined, raw: InstanceCredentialInput, file = workspaceTemplatesFile(), keyFile?: string): Promise<InstanceCredentialSummary> {
  const input = normalize(raw);
  return updateWorkspaceTemplateStore(file, async store => {
    const previous = id === undefined ? undefined : find(store, id);
    if (previous && input.expectedRevision !== undefined && input.expectedRevision !== previous.revision) throw invalidArguments("This credential changed in another view. Refresh before saving grants or rotating it.");
    const credentialId = previous?.id ?? randomUUID();
    validateGrants(store, input, credentialId);
    if (!previous && !input.secretValue) throw invalidArguments("Enter a secret value");
    if (previous && (previous.envName !== input.envName || previous.hostPattern !== input.hostPattern || previous.allowInPath !== input.allowInPath) && !input.secretValue) throw invalidArguments("Re-enter the secret when changing its variable, hosts or path permission");
    const { secretValue, expectedRevision: _, ...metadata } = input;
    // Never generate a replacement master key over a catalogue that already has ciphertext.
    if (secretValue) {
      const existing = store.credentials?.[0];
      if (existing) await decryptWorkspaceTemplateValue(encryptionScope, existing.id, existing.encryptedSecret, keyFile);
      else {
        const configurations = [store.global, ...store.workspaceTemplates];
        const secret = configurations.flatMap(item => item.secrets ?? []).find(item => item.encryptedSecret);
        const ssh = configurations.flatMap(item => item.sshKeys ?? [])[0];
        if (secret) await decryptWorkspaceTemplateValue(secret.projectId, secret.id, secret.encryptedSecret!, keyFile);
        else if (ssh) await decryptWorkspaceTemplateValue(ssh.projectId, ssh.id, ssh.encryptedPrivateKey, keyFile);
      }
    }
    const now = new Date().toISOString();
    const stored: StoredInstanceCredential = { ...metadata, id: credentialId, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now, lastUsedAt: previous?.lastUsedAt,
      encryptedSecret: secretValue ? await encryptWorkspaceTemplateValue(encryptionScope, credentialId, secretValue, keyFile) : previous!.encryptedSecret };
    store.credentials = [...(store.credentials ?? []).filter(item => item.id !== credentialId), stored];
    audit(store, credentialId, !previous ? "created" : secretValue ? "rotated" : "updated");
    return summary(stored);
  });
}
export async function deleteInstanceCredential(id: string, file = workspaceTemplatesFile()) {
  return updateWorkspaceTemplateStore(file, store => {
    const deleted = summary(find(store, id));
    store.credentials = store.credentials!.filter(item => item.id !== id);
    audit(store, id, "deleted");
    return deleted;
  });
}
/** Metadata and opaque placeholders only; never enumerate ungranted credentials. */
export async function grantedInstanceCredentials(templateId: string | undefined, file = workspaceTemplatesFile()) {
  if (!templateId) return [];
  const store = await readWorkspaceTemplateStore(file);
  if (!store.workspaceTemplates.some(item => item.id === templateId)) return [];
  return (store.credentials ?? []).filter(item => item.enabled && item.templateIds.includes(templateId)).map(item => ({ ...summary(item), placeholder: credentialPlaceholder(item.id) }));
}
/** Recheck the exact saved policy on each use, including requests using older cached hooks. */
export async function resolveInstanceCredential(expected: InstanceCredentialSummary, templateId: string, file = workspaceTemplatesFile(), keyFile?: string): Promise<string> {
  const store = await readWorkspaceTemplateStore(file);
  const current = find(store, expected.id);
  if (!store.workspaceTemplates.some(item => item.id === templateId) || !current.enabled || !current.templateIds.includes(templateId)
    || current.envName !== expected.envName || current.hostPattern !== expected.hostPattern || current.allowInPath !== expected.allowInPath) throw invalidArguments("Credential grant or destination policy changed; refresh the request");
  const value = await decryptWorkspaceTemplateValue(encryptionScope, current.id, current.encryptedSecret, keyFile);
  // Usage means proxy resolution, not upstream success. At most one persisted update per minute.
  if (!current.lastUsedAt || Date.now() - Date.parse(current.lastUsedAt) >= 60_000) await updateWorkspaceTemplateStore(file, latest => {
    const item = find(latest, current.id);
    if (!item.enabled || !item.templateIds.includes(templateId) || item.revision !== current.revision) throw invalidArguments("Credential changed during request admission");
    item.lastUsedAt = new Date().toISOString();
  });
  return value;
}
