import { join, posix } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { readJsonObject, invalidArguments, type JsonValue } from "@kintsugi/core";
import { buttonHtml } from "@kintsugi/design-system/button";
import { Icons } from "@kintsugi/design-system/icons";
import { readEditableFile, writeEditableFile, EditableFileError, uploadFile, FilesPathError, filesDiskChanged } from "@kintsugi/files/server";
import { escapeHtml, type WorkspaceModule, type WorkspaceWorkViewPresentation } from "@kintsugi/shared";
import { textResponse } from "@kintsugi/shared/http";
import { createView, views, type DiagramView } from "./state.ts";
import { diagramPath, emptyDiagram, vendorPath } from "./paths.ts";
import { renderDiagramPreview } from "./preview.ts";

const referenceSchema = Type.Object({ type: Type.Literal("drawio"), id: Type.String({ pattern: "^drawio-[a-zA-Z0-9-]+$" }) });
type Reference = Static<typeof referenceSchema>;
const inputSchema = Type.Object({ path: Type.Optional(Type.String()), create: Type.Optional(Type.Boolean()) });
const saveSchema = Type.Object({ content: Type.String(), revision: Type.String() });

function presentation(view: DiagramView): WorkspaceWorkViewPresentation {
  return { sourceKey: view.id, reference: { type: "drawio", id: view.id }, label: view.path ? posix.basename(view.path) : "Draw.io", iconHtml: Icons.Code, kind: "resource", availability: { phase: "live" } };
}

async function openPath(workspaceId: string, input: string, create: boolean): Promise<string> {
  const path = diagramPath(input);
  try { await readEditableFile(workspaceId, path); }
  catch (error) {
    if (!(error instanceof EditableFileError) || error.status !== 404 || !create) throw error;
    await uploadFile(workspaceId, posix.dirname(path), posix.basename(path), false, new TextEncoder().encode(emptyDiagram));
    filesDiskChanged(workspaceId);
  }
  return path;
}

function render(workspaceId: string, view: DiagramView): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/drawio/${view.id}`;
  const closeUrl = `/workspaces/${encodeURIComponent(workspaceId)}/work-views/${encodeURIComponent(JSON.stringify({ type: "drawio", id: view.id }))}/close`;
  const button = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Open" } });
  const download = buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Download copy" }, attributesHtml: 'data-action="drawio#download"' });
  const reload = buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Reload from disk" }, attributesHtml: 'data-action="drawio#reload"' });
  // Keep the editor alive across shell refreshes, but replace it when its path changes.
  const editorId = `${view.id}-${Bun.hash(view.path).toString(16)}`;
  return `<section class="work-view-pane drawio-pane" data-work-view-source="${view.id}">
    <form class="work-view-toolbar drawio-toolbar" method="post" action="${base}/open">
      <input class="text-field" name="path" value="${escapeHtml(view.path)}" placeholder="/work/diagram.drawio" aria-label="Diagram file path" required>
      <label><input type="checkbox" name="create" value="1"> Create if missing</label>${button}
    </form>
    ${view.path ? `<div id="${editorId}" data-turbo-permanent class="drawio-editor" data-controller="drawio" data-drawio-file-url="${base}/content" data-drawio-filename="${escapeHtml(posix.basename(view.path))}" data-drawio-theme-url="/drawio-editor-theme.css" data-drawio-open-url="${base}/open" data-drawio-close-url="${escapeHtml(closeUrl)}">
      <div class="drawio-statusbar">${reload}${download}<span role="status" data-drawio-status>Loading diagram…</span></div>
      <iframe title="Draw.io diagram editor" data-drawio-frame src="/drawio/vendor/index.html?embed=1&amp;proto=json&amp;configure=1&amp;dark=0&amp;spin=1&amp;modified=0&amp;noSaveBtn=1&amp;noExitBtn=1&amp;saveAndExit=0&amp;libraries=0&amp;stealth=1&amp;ui=kennedy" allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"></iframe>
    </div>` : '<p class="drawio-empty">Choose a workspace .drawio file, or enter a new filename and select “Create if missing”. Parent folders must already exist.</p>'}
  </section>`;
}

export const kintsugiServerModule: WorkspaceModule = {
  id: "drawio",
  staticFiles: {
    "/drawio.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    "/drawio-editor-theme.css": { url: new URL("../client/editor-theme.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  workViews: [{
    type: "drawio",
    parseReference(value: JsonValue): Reference {
      if (!Value.Check(referenceSchema, value)) throw invalidArguments("Invalid Draw.io view reference");
      return value;
    },
    identity: (reference: Reference) => reference.id,
    render: ({ workspaceId, reference }: { workspaceId: string; reference: Reference }) => {
      const view = views.read(workspaceId).find(view => view.id === reference.id);
      if (!view) throw invalidArguments("Draw.io view not found");
      return render(workspaceId, view);
    },
    close: ({ workspaceId, reference }: { workspaceId: string; reference: Reference }) => views.write(workspaceId, views.read(workspaceId).filter(view => view.id !== reference.id)),
  }],
  commands: [{
    id: "drawio.create", inputSchema,
    async execute({ workspaceId, input }) {
      const args = Value.Parse(inputSchema, input);
      const path = args.path ? await openPath(workspaceId, args.path, args.create === true) : "";
      const view = createView(workspaceId, path);
      return { createdWorkView: { type: "drawio", id: view.id } };
    },
  }],
  initialize(context) { context.onWorkspaceRemoved(workspaceId => views.delete(workspaceId)); },
  attachToWorkspace({ workspaceId }) {
    return { workViews: views.read(workspaceId).map(presentation), commands: [{ id: "drawio.create", label: "New Draw.io", scope: "workspace", surfaces: { ui: { placement: "work-launcher", iconHtml: Icons.Code, label: "Draw.io" } } }] };
  },
  routes: [{ async handle(request, url, context) {
    if (/^\/workspaces\/[^/]+\/drawio\/preview$/.test(url.pathname)) {
      if (request.method !== "POST") return textResponse("Method not allowed", { status: 405 });
      const xml = await request.text();
      if (xml.length > 2 * 1024 * 1024) return textResponse("Diagram is too large to preview", { status: 413 });
      try {
        return new Response(renderDiagramPreview(xml), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      } catch (error) {
        return textResponse(`Could not preview diagram: ${String(error)}`, { status: 422 });
      }
    }
    const openMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/drawio\/open$/);
    if (openMatch) {
      if (request.method !== "POST") return textResponse("Method not allowed", { status: 405 });
      const workspaceId = decodeURIComponent(openMatch[1]!);
      const form = await request.formData();
      try {
        const path = await openPath(workspaceId, String(form.get("path") ?? ""), false);
        const view = views.read(workspaceId).find(view => view.path === path) ?? createView(workspaceId, path);
        return await context.openWorkView(workspaceId, { type: "drawio", id: view.id });
      } catch (error) {
        if (error instanceof EditableFileError || error instanceof FilesPathError) return textResponse(error.message, { status: error.status });
        throw error;
      }
    }
    if (url.pathname.startsWith("/drawio/vendor/") && request.method === "GET") {
      const path = vendorPath(url.pathname.slice("/drawio/vendor/".length));
      const file = Bun.file(join(new URL("../../../../apps/web/public/drawio/", import.meta.url).pathname, path));
      if (!await file.exists()) return textResponse("Editor asset not found", { status: 404 });
      return new Response(file, { headers: { "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600" } });
    }
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/drawio\/(drawio-[a-zA-Z0-9-]+)\/(open|content)$/);
    if (!match) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const view = views.read(workspaceId).find(view => view.id === match[2]);
    if (!view) return textResponse("Draw.io view not found", { status: 404 });
    try {
      if (match[3] === "open" && request.method === "POST") {
        const form = await request.formData();
        view.path = await openPath(workspaceId, String(form.get("path") ?? ""), form.get("create") === "1");
        views.write(workspaceId, views.read(workspaceId));
        return await context.openWorkView(workspaceId, { type: "drawio", id: view.id });
      }
      if (match[3] === "content" && request.method === "GET") return Response.json(await readEditableFile(workspaceId, diagramPath(view.path)), { headers: { "Cache-Control": "no-store" } });
      if (match[3] === "content" && request.method === "PUT") {
        const input = await readJsonObject(request);
        if (!Value.Check(saveSchema, input)) throw invalidArguments("Invalid diagram save");
        const revision = await writeEditableFile(workspaceId, diagramPath(view.path), input.content, input.revision, false);
        filesDiskChanged(workspaceId);
        return Response.json({ revision });
      }
      return textResponse("Method not allowed", { status: 405 });
    } catch (error) {
      if (error instanceof EditableFileError || error instanceof FilesPathError) return match[3] === "open"
        ? textResponse(error.message, { status: error.status })
        : Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  } }],
};
