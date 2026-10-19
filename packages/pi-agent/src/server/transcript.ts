import { join } from "node:path";
import { getKintsugiRuntimeContext } from "@kintsugi/core";
import { recordsFromSessionEntries } from "./session-records.ts";
import { type TranscriptRecord } from "@kintsugi/agent/server/transcript";
import { latestNativeSessionFile, loadNativeTranscriptFiles, loadNativeTranscriptImage, nativeImageTypes, nativeJsonlRows, nativeSessionFiles } from "@kintsugi/cli-agent/server";
import { Type } from "typebox";
import { Value } from "typebox/value";

const rowSchema = Type.Object({
  type: Type.String(), id: Type.String(), parentId: Type.Union([Type.String(), Type.Null()]), timestamp: Type.String(),
  message: Type.Optional(Type.Object({ role: Type.String(), content: Type.Optional(Type.Union([Type.String(), Type.Array(Type.Object({ type: Type.String() }))])) })),
});
const imageSchema = Type.Object({ type: Type.Literal("image"), mimeType: Type.String(), data: Type.String() });

/** Pi sessions are trees. Show only the current leaf's ancestry, never abandoned branches. */
export function piTranscriptRecords(jsonl: string): TranscriptRecord[] {
  const entries = Array.from(nativeJsonlRows(jsonl, rowSchema));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const lineage = new Set<string>();
  let current = entries.at(-1);
  while (current && !lineage.has(current.id)) {
    lineage.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return recordsFromSessionEntries(entries.filter((entry) => lineage.has(entry.id))).map((record) => record.kind === "user" || record.kind === "toolResult"
    ? { ...record, images: record.images.filter((image) => image.mimeType && nativeImageTypes.has(image.mimeType)) }
    : record);
}

function sessionDirectory(workspaceId: string, sessionId: string): string {
  return join(getKintsugiRuntimeContext().kintsugiDataDir, "workspaces", workspaceId, "home-local", ".local", "share", "pi", "sessions", sessionId);
}
export async function piHistoryFiles(workspaceId: string, sessionId: string): Promise<string[]> {
  return nativeSessionFiles(sessionDirectory(workspaceId, sessionId));
}
export async function loadPiTranscript(workspaceId: string, sessionId: string): Promise<TranscriptRecord[] | undefined> {
  return loadNativeTranscriptFiles(await piHistoryFiles(workspaceId, sessionId), piTranscriptRecords);
}
export async function loadPiTranscriptImage(workspaceId: string, sessionId: string, entryId: string, contentIndex: number): Promise<Response> {
  return loadNativeTranscriptImage(await piHistoryFiles(workspaceId, sessionId), (jsonl) => {
    for (const entry of nativeJsonlRows(jsonl, rowSchema)) {
      if (entry.id !== entryId || entry.type !== "message" || !Array.isArray(entry.message?.content)) continue;
      const image = entry.message.content[contentIndex];
      if (Value.Check(imageSchema, image) && nativeImageTypes.has(image.mimeType)) return image;
    }
    return undefined;
  });
}

/** Session storage is private to this tab, not the workspace's most recent agent. */
export async function piResumePath(workspaceId: string, sessionId: string): Promise<string | undefined> {
  const file = await latestNativeSessionFile(sessionDirectory(workspaceId, sessionId));
  return file?.replace(join(getKintsugiRuntimeContext().kintsugiDataDir, "workspaces", workspaceId, "home-local"), "/home/agent");
}
