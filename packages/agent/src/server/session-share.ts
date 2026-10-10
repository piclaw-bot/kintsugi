import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getKintsugiRuntimeContext } from "@kintsugi/core";
import type { GitWorkspaceTemplateInitInstruction } from "@kintsugi/workspace-templates";
import { isGitWorkspaceTemplateInit } from "@kintsugi/workspace-templates";
import type { WorkspaceInitInstruction } from "@kintsugi/workspace";

const projectlessSessionShareKey = "projectless";
export const sessionShareMountPath = "/kintsugi/session-share";

function workspaceMetadataInitPath(workspaceId: string, dataDir = getKintsugiRuntimeContext().kintsugiDataDir): string {
  return join(dataDir, "workspaces", workspaceId, "metadata", "init.json");
}

async function readWorkspaceTemplateInit(workspaceId: string, dataDir = getKintsugiRuntimeContext().kintsugiDataDir): Promise<GitWorkspaceTemplateInitInstruction | undefined> {
  const file = Bun.file(workspaceMetadataInitPath(workspaceId, dataDir));
  if (!(await file.exists())) return undefined;
  const init: unknown = JSON.parse(await file.text());
  return isGitWorkspaceTemplateInit(init) ? init : undefined;
}

function sessionSlug(value: string, maxLength: number, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function sessionShareKeySlug(value: string): string {
  return sessionSlug(value, 80, projectlessSessionShareKey);
}

export function sessionShareKeyForInit(init: WorkspaceInitInstruction | undefined): string {
  if (!isGitWorkspaceTemplateInit(init)) return projectlessSessionShareKey;
  const key = init.sessionShareKey.trim()
    ? init.sessionShareKey
    : init.name;
  return sessionShareKeySlug(key);
}

export async function workspaceSessionShareKey(workspaceId: string, dataDir = getKintsugiRuntimeContext().kintsugiDataDir): Promise<string> {
  return sessionShareKeyForInit(await readWorkspaceTemplateInit(workspaceId, dataDir));
}

export function sessionShareDir(shareKey: string, dataDir = getKintsugiRuntimeContext().kintsugiDataDir): string {
  return join(dataDir, "session-shares", sessionShareKeySlug(shareKey));
}

/** Publish a complete snapshot while its source may continue receiving turns. */
export async function publishSessionSnapshot(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
