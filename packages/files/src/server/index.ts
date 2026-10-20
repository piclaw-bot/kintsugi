import { renderDelimitedRequest } from "./delimited-preview.ts";
import type { JsonValue } from "@kintsugi/core";
import { Icons } from "@kintsugi/design-system/icons";
import { renderMarkdown } from "@kintsugi/markdown";
import { parseWorkspaceFileTarget, type WorkspaceFileTarget, type WorkspaceModule, type WorkspaceModuleRouteContext } from "@kintsugi/shared";
import { jsonResponse, matchRoute, response, textResponse } from "@kintsugi/shared/http";
import { workspaceRoot } from "@kintsugi/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { fileSaveRequestSchema, type FileSaveRequest } from "../protocol.ts";
import { EditableFileError, readEditableFile, requestedEditableFilePath, writeEditableFile } from "./editable-file.ts";
import { deleteFile, FilesPathError, getDirectoryEntry, listFiles, searchFiles, uploadFile } from "./files.ts";
import { filePreviewKind } from "./file-preview.ts";
import { filesWorkViewPresentation, renderFilesDirectoryFrame, renderFilesRefreshSignal, renderFilesTreeFrame, renderFilesTreeResultsFrame, renderFilesWorkViewBody } from "./render.ts";
import { closeFilesView, createFilesView, defaultFilesViewId, deleteFilesViewState, filesDiskChanged, filesView, listFilesViews, setFilesViewFile } from "./state.ts";

const filesWorkViewReferenceSchema = Type.Object({ type: Type.Literal("files"), id: Type.String() });
type FilesWorkViewReference = Static<typeof filesWorkViewReferenceSchema>;

async function filesEndpoint(workspaceId: string, url: URL): Promise<Response> {
  const viewId = url.searchParams.get("filesView") ?? defaultFilesViewId;
  const filesState = filesView(workspaceId, viewId);
  const query = url.searchParams.get("q");
  if (query !== null) {
    const normalizedQuery = query.trim();
    const selectedPath = filesState.path;
    const expandedPaths = new Set(url.searchParams.getAll("expanded"));
    const entries = normalizedQuery ? await searchFiles(workspaceId, normalizedQuery, expandedPaths) : (await listFiles(workspaceId, workspaceRoot, undefined, expandedPaths)).entries;
    return response(renderFilesTreeResultsFrame(workspaceId, viewId, entries, selectedPath, Boolean(normalizedQuery)));
  }
  const view = url.searchParams.get("view");
  if (view === "inline" || view === "collapsed") {
    const entry = await getDirectoryEntry(workspaceId, url.searchParams.get("path"));
    const listing = view === "inline" ? await listFiles(workspaceId, entry.directoryPath ?? entry.path) : undefined;
    return response(renderFilesDirectoryFrame(workspaceId, viewId, entry, listing?.entries, filesState.path));
  }
  const listing = await listFiles(workspaceId, workspaceRoot, filesState.path);
  return response(renderFilesTreeFrame(workspaceId, viewId, listing.entries, filesState.path));
}

export async function openFileInFiles(workspaceId: string, target: WorkspaceFileTarget, openWorkView: WorkspaceModuleRouteContext["openWorkView"], requestedViewId?: string): Promise<Response> {
  const path = requestedEditableFilePath(target.path);
  const viewId = requestedViewId ?? defaultFilesViewId;
  setFilesViewFile(workspaceId, viewId, path, target);
  return await openWorkView(workspaceId, { type: "files", id: viewId }, { select: requestedViewId === undefined });
}

async function renderMarkdownEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  if (request.method !== "POST") return textResponse("Method not allowed", { status: 405 });
  const sourcePath = url.searchParams.get("path");
  const options = sourcePath?.startsWith("/") ? { sourcePath, frontmatter: true } : { frontmatter: true };
  return response(renderMarkdown(workspaceId, await request.text(), options));
}

async function fileContentEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  const path = url.searchParams.get("path");
  const kind = await filePreviewKind(workspaceId, requestedEditableFilePath(path));
  if (kind === "large-text") throw new EditableFileError("Files larger than 2 MB cannot be edited", 413);
  if (kind !== "text") throw new EditableFileError("Only text files can be edited", 415);
  if (request.method === "GET") return jsonResponse(await readEditableFile(workspaceId, path));
  if (request.method !== "PUT") return textResponse("Method not allowed", { status: 405 });
  const body: unknown = await request.json();
  if (!Value.Check(fileSaveRequestSchema, body)) return textResponse("Invalid file save", { status: 422 });
  const save: FileSaveRequest = body;
  try {
    const revision = await writeEditableFile(workspaceId, path, save.content, save.revision, save.force === true);
    filesDiskChanged(workspaceId);
    return jsonResponse({ revision });
  } catch (error) {
    if (error instanceof EditableFileError && error.status === 409) return jsonResponse(await readEditableFile(workspaceId, path), { status: 409 });
    throw error;
  }
}

async function uploadEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  const content = new Uint8Array(await request.arrayBuffer());
  await uploadFile(workspaceId, url.searchParams.get("destination"), url.searchParams.get("name"), url.searchParams.get("overwrite") === "1", content);
  filesDiskChanged(workspaceId);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function deleteEndpoint(workspaceId: string, request: Request, openWorkView: WorkspaceModuleRouteContext["openWorkView"]): Promise<Response> {
  const form = await request.formData();
  const viewId = String(form.get("filesView") ?? defaultFilesViewId);
  await deleteFile(workspaceId, String(form.get("path") ?? ""));
  filesDiskChanged(workspaceId);
  setFilesViewFile(workspaceId, viewId);
  return await openWorkView(workspaceId, { type: "files", id: viewId }, { select: false });
}

const filesWorkspaceModule: WorkspaceModule = {
  id: "files",
  workViews: [{
    type: "files",
    parseReference(value: JsonValue) {
      if (!Value.Check(filesWorkViewReferenceSchema, value)) throw new Error("Files reference requires an id");
      return { type: value.type, id: value.id };
    },
    identity: (reference: FilesWorkViewReference) => reference.id,
    render: async ({ workspaceId, reference }: { workspaceId: string; reference: FilesWorkViewReference }) => {
      const view = filesView(workspaceId, reference.id);
      try {
        return renderFilesWorkViewBody(workspaceId, view, view.path ? await filePreviewKind(workspaceId, view.path) : undefined);
      } catch (error) {
        if (error instanceof EditableFileError) return renderFilesWorkViewBody(workspaceId, view, "binary", error.message);
        throw error;
      }
    },
    close: ({ workspaceId, reference }: { workspaceId: string; reference: FilesWorkViewReference }) => closeFilesView(workspaceId, reference.id),
  }],
  commands: [
    { id: "files.create", execute: ({ workspaceId }) => ({ createdWorkView: { type: "files", id: createFilesView(workspaceId).id } }) },
    { id: "files.open", execute: ({ workspaceId }) => ({ createdWorkView: { type: "files", id: listFilesViews(workspaceId)[0]!.id } }) },
  ],
  openApiPaths: {
    "/workspaces/{id}/files-view/render-table": {
      post: { summary: "Preview supplied UTF-8 CSV/TSV text without reading or saving files (2 MB, 500 rows, 80 columns)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "path", in: "query", required: true, schema: { type: "string" }, description: "Filename determines CSV or tab-separated parsing" }], requestBody: { required: true, content: { "text/plain": { schema: { type: "string", maxLength: 2000000 } } } }, responses: { "200": { description: "Server-rendered, escaped table preview" }, "413": { description: "Input exceeds the byte limit" }, "422": { description: "Malformed delimited text" } } },
    },
  },
  staticFiles: { "/files.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  routes: [{
    async handle(request, url, context) {
      try {
        let match = matchRoute(url, /^\/workspaces\/([^/]+)\/files-view\/(open|content|render-markdown|render-table)$/);
        if (match) {
          const workspaceId = match[0]!;
          if (match[1] === "open") return request.method === "GET" ? await openFileInFiles(workspaceId, parseWorkspaceFileTarget(url.searchParams), context.openWorkView, url.searchParams.get("filesView") ?? undefined) : textResponse("Method not allowed", { status: 405 });
          if (match[1] === "content") return await fileContentEndpoint(workspaceId, request, url);
          if (match[1] === "render-table") return request.method === "POST" ? await renderDelimitedRequest(request, url.searchParams.get("path") ?? "") : textResponse("Method not allowed", { status: 405 });
          return await renderMarkdownEndpoint(workspaceId, request, url);
        }

        match = matchRoute(url, /^\/workspaces\/([^/]+)\/files$/);
        if (match) return request.method === "GET" ? await filesEndpoint(match[0]!, url) : textResponse("Method not allowed", { status: 405 });

        match = matchRoute(url, /^\/workspaces\/([^/]+)\/files-view\/(upload|delete)$/);
        if (!match) return undefined;
        const workspaceId = match[0]!;
        if (match[1] === "upload") return request.method === "POST" ? await uploadEndpoint(workspaceId, request, url) : textResponse("Method not allowed", { status: 405 });
        return request.method === "POST" ? await deleteEndpoint(workspaceId, request, context.openWorkView) : textResponse("Method not allowed", { status: 405 });
      } catch (error) {
        if (error instanceof FilesPathError || error instanceof EditableFileError) return textResponse(error.message, { status: error.status });
        throw error;
      }
    },
  }],
  initialize(context) {
    context.events.on("workspace_agent_turn_finished", ({ workspaceId }) => {
      filesDiskChanged(workspaceId);
      context.invalidateWorkspace(workspaceId);
    });
    context.onWorkspaceRemoved((workspaceId) => deleteFilesViewState(workspaceId));
  },
  attachToWorkspace({ workspaceId }) {
    return {
      workViews: listFilesViews(workspaceId).map(filesWorkViewPresentation),
      commands: [
        { id: "files.create", label: "New Files", scope: "workspace", surfaces: { ui: { placement: "work-launcher", shortcutCommandId: "files.open", iconHtml: Icons.Files, label: "Files" } } },
        { id: "files.open", label: "Open Files", description: "Open the existing Files view, or create one if none exists.", scope: "workspace", surfaces: { shortcut: { defaultBinding: "Meta+Alt+KeyF" } } },
      ],
      overlayHtml: [renderFilesRefreshSignal(workspaceId)],
    };
  },
};

export { filesWorkspaceModule as kintsugiServerModule };

// Shared file operations for specialized workspace editors.
export { readEditableFile, writeEditableFile, EditableFileError, uploadFile, FilesPathError, filesDiskChanged };
