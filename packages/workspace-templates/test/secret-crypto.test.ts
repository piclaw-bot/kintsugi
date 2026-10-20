import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptWorkspaceTemplateValue, encryptWorkspaceTemplateValue } from "../src/secret-crypto.ts";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "template-secret-crypto-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("decrypting without the original key fails without creating a replacement", async () => {
  const encrypted = await encryptWorkspaceTemplateValue("template", "secret", "fixture", join(directory, "original.key"));
  const missingKey = join(directory, "missing.key");
  await expect(decryptWorkspaceTemplateValue("template", "secret", encrypted, missingKey)).rejects.toMatchObject({ code: "workspace_template_secret_key_missing" });
  expect(await Bun.file(missingKey).exists()).toBe(false);
});

test("a mismatched key reports which saved value failed and does not replace the key", async () => {
  const encrypted = await encryptWorkspaceTemplateValue("template", "secret", "fixture", join(directory, "original.key"));
  const otherKey = join(directory, "other.key");
  await encryptWorkspaceTemplateValue("other", "secret", "other fixture", otherKey);
  const before = await readFile(otherKey, "utf8");
  await expect(decryptWorkspaceTemplateValue("template", "secret", encrypted, otherKey)).rejects.toMatchObject({ code: "workspace_template_secret_decryption_failed", message: expect.stringContaining("Restore projects.json and project-secrets.key from the same source") });
  expect(await readFile(otherKey, "utf8")).toBe(before);
});
test("concurrent first encryptions share one master key without replacing it", async () => {
  const key = join(directory, "concurrent.key");
  const encrypted = await Promise.all(Array.from({ length: 8 }, (_, index) => encryptWorkspaceTemplateValue("template", String(index), `fixture-${index}`, key)));
  expect(await Promise.all(encrypted.map((value, index) => decryptWorkspaceTemplateValue("template", String(index), value, key)))).toEqual(Array.from({ length: 8 }, (_, index) => `fixture-${index}`));
});
