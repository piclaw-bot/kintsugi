import type { JsonValue } from "@kintsugi/core";
import { createWorkspaceMetadataState } from "@kintsugi/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const filesViewSchema = Type.Object({
  id: Type.String(),
  path: Type.Optional(Type.String({ pattern: "^/" })),
  line: Type.Optional(Type.Number()),
  column: Type.Optional(Type.Number()),
  // An optional field keeps Office views readable by older Files implementations.
  viewer: Type.Optional(Type.Literal("office")),
});
const filesViewsSchema = Type.Array(filesViewSchema);

export type FilesView = Static<typeof filesViewSchema>;
export type FilesWorkViewReference = { type: "files"; id: string };
export const defaultFilesViewId = "workspace";
const navigationRequests = new Map<string, string>();
export function filesNavigationRequest(workspaceId: string, id: string): string { return navigationRequests.get(`${workspaceId}:${id}`) ?? ""; }

function parseFilesViews(value: JsonValue): FilesView[] {
  if (!Value.Check(filesViewsSchema, value)) throw new Error("invalid persisted Files views");
  return value;
}

const filesViews = createWorkspaceMetadataState("files-work-views.json", parseFilesViews, () => [{ id: defaultFilesViewId }]);

export function listFilesViews(workspaceId: string): FilesView[] {
  const views = filesViews.read(workspaceId);
  if (views.some((view) => view.id === defaultFilesViewId)) return views;
  const withDefault = [{ id: defaultFilesViewId }, ...views];
  filesViews.write(workspaceId, withDefault);
  return withDefault;
}

function requireFilesView(views: FilesView[], id: string): FilesView {
  const view = views.find((candidate) => candidate.id === id);
  if (!view) throw new Error(`Files view not found: ${id}`);
  return view;
}

export function filesView(workspaceId: string, id: string): FilesView {
  return requireFilesView(listFilesViews(workspaceId), id);
}

export function setFilesViewFile(workspaceId: string, id: string, path?: string, position: { line?: number; column?: number } = {}): FilesView {
  const views = listFilesViews(workspaceId);
  const view = requireFilesView(views, id);
  navigationRequests.set(`${workspaceId}:${id}`, crypto.randomUUID());
  view.path = path;
  view.line = position.line;
  view.column = position.column;
  filesViews.write(workspaceId, views);
  return view;
}

export function createFilesView(workspaceId: string): FilesView {
  const views = listFilesViews(workspaceId);
  const view: FilesView = { id: crypto.randomUUID() };
  views.push(view);
  filesViews.write(workspaceId, views);
  return view;
}

export function createOfficeView(workspaceId: string, path?: string): FilesView {
  const views = listFilesViews(workspaceId);
  const existing = path ? views.find(view => view.viewer === "office" && view.path === path) : undefined;
  if (existing) return existing;
  const view: FilesView = { id: crypto.randomUUID(), viewer: "office" };
  if (path) view.path = path;
  views.push(view); filesViews.write(workspaceId, views); return view;
}

export function closeFilesView(workspaceId: string, id: string): void {
  navigationRequests.delete(`${workspaceId}:${id}`);
  filesViews.write(workspaceId, filesViews.read(workspaceId).filter((view) => view.id !== id));
}

export function deleteFilesViewState(workspaceId: string): void {
  diskGenerations.delete(workspaceId);
  for (const key of navigationRequests.keys()) if (key.startsWith(`${workspaceId}:`)) navigationRequests.delete(key);
  filesViews.delete(workspaceId);
}

const diskGenerations = new Map<string, number>();
export function filesDiskGeneration(workspaceId: string): number { return diskGenerations.get(workspaceId) ?? 0; }
export function filesDiskChanged(workspaceId: string): void { diskGenerations.set(workspaceId, filesDiskGeneration(workspaceId) + 1); }
