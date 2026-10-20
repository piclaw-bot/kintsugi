import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireFileLock, KintsugiCoreError, getKintsugiRuntimeContext, isNotFoundError } from "@kintsugi/core";

const keyBytes = 32;
const ivBytes = 12;

function workspaceTemplateSecretsKeyFile(dataDir = getKintsugiRuntimeContext().kintsugiDataDir): string {
  return join(dataDir, "project-secrets.key");
}

async function readMasterKey(file: string): Promise<Buffer> {
  const key = Buffer.from((await readFile(file, "utf8")).trim(), "base64url");
  if (key.byteLength !== keyBytes) throw new KintsugiCoreError("invalid_workspace_template_secret_key", `template secrets key must be ${keyBytes} bytes`);
  return key;
}

async function readOrCreateMasterKey(file: string): Promise<Buffer> {
  const release = await acquireFileLock(`${file}.lock`, "secret encryption key");
  try {
    return await readOrCreateLockedMasterKey(file);
  } finally { await release(); }
}
async function readOrCreateLockedMasterKey(file: string): Promise<Buffer> {
  try {
    return await readMasterKey(file);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const key = randomBytes(keyBytes);
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(file, `${key.toString("base64url")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (failure) {
      if (!(failure instanceof Error) || !("code" in failure) || failure.code !== "EEXIST") throw failure;
      return readMasterKey(file);
    }
    await chmod(file, 0o600);
    return key;
  }
}

function aad(workspaceTemplateId: string, secretId: string): Buffer {
  return Buffer.from(`project-secret:${workspaceTemplateId}:${secretId}:v1`, "utf8");
}

export async function encryptWorkspaceTemplateValue(workspaceTemplateId: string, secretId: string, plaintext: string, keyFile = workspaceTemplateSecretsKeyFile()): Promise<string> {
  const key = await readOrCreateMasterKey(keyFile);
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(workspaceTemplateId, secretId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64url")}`;
}

export async function decryptWorkspaceTemplateValue(workspaceTemplateId: string, secretId: string, encryptedValue: string, keyFile = workspaceTemplateSecretsKeyFile()): Promise<string> {
  const [version, encodedIv, encodedPayload] = encryptedValue.split(":");
  if (version !== "v1" || !encodedIv || !encodedPayload) throw new KintsugiCoreError("invalid_workspace_template_secret_ciphertext", `invalid template secret ciphertext: ${secretId}`);
  const payload = Buffer.from(encodedPayload, "base64url");
  if (payload.byteLength < 16) throw new KintsugiCoreError("invalid_workspace_template_secret_ciphertext", `invalid template secret ciphertext: ${secretId}`);
  let key: Buffer;
  try {
    key = await readMasterKey(keyFile);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    throw new KintsugiCoreError("workspace_template_secret_key_missing", `Cannot decrypt secrets or SSH keys for template ${workspaceTemplateId}: ${keyFile} is missing. Restore the original key alongside projects.json; generating a new key won’t unlock saved values.`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encodedIv, "base64url"));
  decipher.setAAD(aad(workspaceTemplateId, secretId));
  decipher.setAuthTag(payload.subarray(-16));
  try {
    return Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString("utf8");
  } catch {
    throw new KintsugiCoreError("workspace_template_secret_decryption_failed", `Cannot decrypt saved value ${secretId} for template ${workspaceTemplateId}. The key in ${keyFile} does not match the saved data, or the data is damaged. Restore projects.json and project-secrets.key from the same source.`);
  }
}
