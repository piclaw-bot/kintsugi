import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addWorkspaceTemplate, deleteWorkspaceTemplate, createWorkspaceTemplateSecret, globalWorkspaceConfiguration } from "../src/index.ts";
import { saveInstanceCredential, listInstanceCredentials, grantedInstanceCredentials, resolveInstanceCredential, deleteInstanceCredential, parseInstanceCredentialInput, type InstanceCredentialInput } from "../src/credentials.ts";

let directory: string, file: string, key: string, template: string;
const values: InstanceCredentialInput = { name: "Deployment", envName: "DEPLOY_TOKEN", type: "token", description: "Deploy test builds", hostPattern: "api.example.com", enabled: true, allowInPath: false, templateIds: [] };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kintsugi-credentials-")); file = join(directory, "projects.json"); key = join(directory, "key");
  template = (await addWorkspaceTemplate("https://example.com/repo.git", file)).workspaceTemplate.id;
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
test("catalogue is encrypted and values are absent from all public summaries, grants and audit", async () => {
  const stored = await saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "fixture-secret-value" }, file, key);
  expect(JSON.stringify(await listInstanceCredentials(file))).not.toContain("fixture-secret-value");
  expect(JSON.stringify(await listInstanceCredentials(file))).not.toContain("encryptedSecret");
  expect(await readFile(file, "utf8")).not.toContain("fixture-secret-value");
  expect((await stat(key)).mode & 0o777).toBe(0o600);
  expect(await resolveInstanceCredential(stored, template, file, key)).toBe("fixture-secret-value");
  expect((await listInstanceCredentials(file)).credentials[0]?.lastUsedAt).toBeTruthy();
  expect(JSON.stringify(await grantedInstanceCredentials(template, file))).not.toContain("fixture-secret-value");
});
test("no grants by default; no access from empty, foreign or future templates", async () => {
  await saveInstanceCredential(undefined, { ...values, secretValue: "fixture" }, file, key);
  expect(await grantedInstanceCredentials(template, file)).toEqual([]);
  expect(await grantedInstanceCredentials(undefined, file)).toEqual([]);
  expect(await grantedInstanceCredentials("missing", file)).toEqual([]);
  const other = (await addWorkspaceTemplate("https://example.com/future.git", file)).workspaceTemplate.id;
  expect(await grantedInstanceCredentials(other, file)).toEqual([]);
});
test("rotation preserves references, revocation and disabling fence previously captured metadata", async () => {
  const original = await saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "original" }, file, key);
  const placeholder = (await grantedInstanceCredentials(template, file))[0]!.placeholder;
  await saveInstanceCredential(original.id, { ...values, templateIds: [template], secretValue: "rotated" }, file, key);
  expect(await resolveInstanceCredential(original, template, file, key)).toBe("rotated");
  expect((await grantedInstanceCredentials(template, file))[0]!.placeholder).toBe(placeholder);
  await saveInstanceCredential(original.id, { ...values, templateIds: [template], enabled: false }, file, key);
  await expect(resolveInstanceCredential(original, template, file, key)).rejects.toThrow("changed");
  await saveInstanceCredential(original.id, { ...values, templateIds: [] }, file, key);
  await expect(resolveInstanceCredential(original, template, file, key)).rejects.toThrow("changed");
  await deleteInstanceCredential(original.id, file);
  await expect(resolveInstanceCredential(original, template, file, key)).rejects.toThrow("not found");
});
test("routing changes require a re-entered value and old request policy cannot broaden", async () => {
  const original = await saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "fixture" }, file, key);
  for (const change of [{ envName: "OTHER" }, { hostPattern: "other.example.com" }, { allowInPath: true }]) await expect(saveInstanceCredential(original.id, { ...values, templateIds: [template], ...change }, file, key)).rejects.toThrow("Re-enter");
  await saveInstanceCredential(original.id, { ...values, templateIds: [template], hostPattern: "other.example.com", secretValue: "new-fixture" }, file, key);
  await expect(resolveInstanceCredential(original, template, file, key)).rejects.toThrow("changed");
});
test("destination, schema and grant validation fail atomically", async () => {
  const before = await readFile(file, "utf8");
  for (const hostPattern of ["*", "*.example.com", "https://api.example.com", "api.example.com:8443", "api.example.com/path", "user@api.example.com"]) await expect(saveInstanceCredential(undefined, { ...values, hostPattern, secretValue: "fixture" }, file, key)).rejects.toThrow("exact DNS");
  await expect(saveInstanceCredential(undefined, { ...values, templateIds: ["missing"], secretValue: "fixture" }, file, key)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
  expect(() => parseInstanceCredentialInput({ ...values, allowInQuery: true })).toThrow();
});
test("duplicate effective variables never silently replace legacy or catalogue credentials", async () => {
  await createWorkspaceTemplateSecret(globalWorkspaceConfiguration, { envName: values.envName, hostPattern: "api.example.com" }, file, key);
  await expect(saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "fixture" }, file, key)).rejects.toThrow("legacy secret");
  await saveInstanceCredential(undefined, { ...values, envName: "OTHER", templateIds: [template], secretValue: "fixture" }, file, key);
  await expect(saveInstanceCredential(undefined, { ...values, name: "Different", envName: "OTHER", templateIds: [template], secretValue: "fixture" }, file, key)).rejects.toThrow("already uses");
});
test("deleting and re-adding the same template does not restore old grants", async () => {
  await saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "fixture" }, file, key);
  await deleteWorkspaceTemplate(template, file);
  const readded = (await addWorkspaceTemplate("https://example.com/repo.git", file)).workspaceTemplate.id;
  expect(readded).toBe(template);
  expect(await grantedInstanceCredentials(template, file)).toEqual([]);
});
test("missing encryption key fails closed without creating a replacement", async () => {
  const credential = await saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "fixture" }, file, key);
  await rm(key);
  await expect(resolveInstanceCredential(credential, template, file, key)).rejects.toThrow("missing");
  expect(await Bun.file(key).exists()).toBe(false);
});
test("stale management forms cannot undo a later revocation", async () => {
  const credential = await saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "fixture" }, file, key);
  await saveInstanceCredential(credential.id, { ...values, templateIds: [], expectedRevision: credential.revision }, file, key);
  await expect(saveInstanceCredential(credential.id, { ...values, templateIds: [template], expectedRevision: credential.revision }, file, key)).rejects.toThrow("changed in another view");
  expect(await grantedInstanceCredentials(template, file)).toEqual([]);
});
test("adding or rotating cannot silently generate a replacement for a lost encryption key", async () => {
  const credential = await saveInstanceCredential(undefined, { ...values, templateIds: [template], secretValue: "original-fixture" }, file, key);
  const before = await readFile(file, "utf8"); await rm(key);
  await expect(saveInstanceCredential(credential.id, { ...values, templateIds: [template], secretValue: "rotation-fixture" }, file, key)).rejects.toThrow("missing");
  await expect(saveInstanceCredential(undefined, { ...values, name: "Second", envName: "SECOND", secretValue: "second-fixture" }, file, key)).rejects.toThrow("missing");
  expect(await Bun.file(key).exists()).toBe(false);
  expect(await readFile(file, "utf8")).toBe(before);
});
