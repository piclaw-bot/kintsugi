import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { kintsugiDataPath, getKintsugiRuntimeContext, readTextIfExists } from "@kintsugi/core";
import { Type } from "typebox";
import { Value } from "typebox/value";

const initialPromptDraftSchema = Type.Object({
  prompt: Type.String(),
  accepted: Type.Optional(Type.Boolean()),
});

function initialPromptDraftWorkspacePath(workspaceId: string): string {
  return kintsugiDataPath(getKintsugiRuntimeContext(), "agent-initial-prompt-drafts", workspaceId);
}

function initialPromptDraftPath(workspaceId: string, agentId: string): string {
  return `${initialPromptDraftWorkspacePath(workspaceId)}/${agentId}.json`;
}

export async function stageInitialPrompt(workspaceId: string, agentId: string, prompt: string): Promise<void> {
  const path = initialPromptDraftPath(workspaceId, agentId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ prompt })}\n`, "utf8");
}

export async function readInitialPromptDraft(workspaceId: string, agentId: string): Promise<{ prompt: string } | undefined> {
  const text = await readTextIfExists(initialPromptDraftPath(workspaceId, agentId));
  if (text === undefined) return undefined;
  const draft = Value.Parse(initialPromptDraftSchema, JSON.parse(text));
  if (draft.accepted === false) {
    await removeInitialPromptDraft(workspaceId, agentId);
    return undefined;
  }
  return { prompt: draft.prompt };
}

export async function removeInitialPromptDraft(workspaceId: string, agentId: string): Promise<void> {
  await rm(initialPromptDraftPath(workspaceId, agentId), { force: true });
}

export async function removeWorkspaceInitialPromptDrafts(workspaceId: string): Promise<void> {
  await rm(initialPromptDraftWorkspacePath(workspaceId), { recursive: true, force: true });
}
