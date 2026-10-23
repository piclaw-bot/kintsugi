import { createKintsugiEventBus } from "@kintsugi/core";
import type { WorkspaceWorkViewReference } from "@kintsugi/shared";
import { describe, expect, test } from "bun:test";
import { kintsugiServerModule } from "../src/server/index.ts";
import { closeFilesView, createFilesView, deleteFilesViewState, filesDiskGeneration, filesView, forgetFilesPath, listFilesViews, navigateFilesViewHistory, setFilesViewFile } from "../src/server/state.ts";

describe("Files view integration", () => {
  test("embed-style links select the file in the default Files view", async () => {
    const request = new Request("http://test.local/workspaces/workspace-progressive/files-view/open?path=%2Fwork%2Fnew.ts");
    let opened: WorkspaceWorkViewReference | undefined;
    // SAFETY: The test fixture supplies the route context fields exercised by this endpoint.
    await kintsugiServerModule.routes![0]!.handle(request, new URL(request.url), {
      openWorkView: async (_workspaceId: string, reference: WorkspaceWorkViewReference) => {
        opened = reference;
        return new Response("<turbo-stream></turbo-stream>");
      },
    } as never);

    expect(opened).toEqual({ type: "files", id: "workspace" });
    expect(listFilesViews("workspace-progressive")[0]?.path).toBe("/work/new.ts");
    deleteFilesViewState("workspace-progressive");
  });

  test("Rendered Markdown omits frontmatter", async () => {
    const request = new Request("http://test.local/workspaces/workspace-frontmatter/files-view/render-markdown?path=%2Fwork%2Fguide.md", {
      method: "POST",
      body: "---\ntitle: Internal title\ndraft: true\n---\n# Public guide",
    });
    // SAFETY: The Markdown preview endpoint does not use the route context.
    const response = await kintsugiServerModule.routes![0]!.handle(request, new URL(request.url), {} as never);

    expect(response?.headers.get("content-type")).toContain("text/html");
    expect(await response?.text()).toBe("<h1>Public guide</h1>");
  });

  test("the Files command creates a blank independent view", async () => {
    const result = await kintsugiServerModule.commands![0]!.execute({ workspaceId: "workspace-command", input: {}, events: createKintsugiEventBus() });
    const created = listFilesViews("workspace-command").find((view) => view.id === result.createdWorkView?.id);
    expect(created?.path).toBeUndefined();
    deleteFilesViewState("workspace-command");
  });

  test("Files views retain independent selections, including the same file", () => {
    const workspaceId = "workspace-independent-files";
    try {
      const first = createFilesView(workspaceId);
      const second = createFilesView(workspaceId);
      setFilesViewFile(workspaceId, first.id, "/work/README.md", { line: 1 });
      setFilesViewFile(workspaceId, second.id, "/work/README.md", { line: 9 });
      expect(listFilesViews(workspaceId).find((view) => view.id === first.id)).toMatchObject({ path: "/work/README.md", line: 1 });
      expect(listFilesViews(workspaceId).find((view) => view.id === second.id)).toMatchObject({ path: "/work/README.md", line: 9 });
      setFilesViewFile(workspaceId, first.id, "/work/other.ts");
      closeFilesView(workspaceId, first.id);
      expect(listFilesViews(workspaceId).find((view) => view.id === second.id)).toMatchObject({ path: "/work/README.md", line: 9 });
    } finally {
      deleteFilesViewState(workspaceId);
    }
  });

  test("Files views keep back and forward history per view", () => {
    const workspaceId = "workspace-history";
    try {
      const view = createFilesView(workspaceId);
      for (const path of ["/work/a.md", "/work/b.md", "/work/b.md", "/work/c.md"]) setFilesViewFile(workspaceId, view.id, path);
      expect(filesView(workspaceId, view.id)).toMatchObject({ path: "/work/c.md", back: ["/work/a.md", "/work/b.md"], forward: [] });
      navigateFilesViewHistory(workspaceId, view.id, "back");
      navigateFilesViewHistory(workspaceId, view.id, "back");
      expect(filesView(workspaceId, view.id)).toMatchObject({ path: "/work/a.md", back: [], forward: ["/work/c.md", "/work/b.md"] });
      navigateFilesViewHistory(workspaceId, view.id, "back");
      expect(filesView(workspaceId, view.id).path).toBe("/work/a.md");
      navigateFilesViewHistory(workspaceId, view.id, "forward");
      expect(filesView(workspaceId, view.id)).toMatchObject({ path: "/work/b.md", back: ["/work/a.md"], forward: ["/work/c.md"] });
      setFilesViewFile(workspaceId, view.id, "/work/d.md");
      expect(filesView(workspaceId, view.id)).toMatchObject({ back: ["/work/a.md", "/work/b.md"], forward: [] });
      forgetFilesPath(workspaceId, "/work/a.md");
      expect(filesView(workspaceId, view.id).back).toEqual(["/work/b.md"]);
    } finally {
      deleteFilesViewState(workspaceId);
    }
  });

  test.each([undefined, "/work/example.ts"])("refreshes Files after an agent turn with selected path %s", async (path) => {
    const events = createKintsugiEventBus();
    const invalidations: string[] = [];
    // SAFETY: The test fixture supplies the module initialization fields exercised by this test.
    await kintsugiServerModule.initialize!({ events, invalidateWorkspace: (workspaceId: string) => invalidations.push(workspaceId), onWorkspaceRemoved: () => {} } as never);
    setFilesViewFile("workspace-events", "workspace", path);
    await events.emit("workspace_agent_turn_finished", { workspaceId: "workspace-events", agentId: "conversation-1" });
    expect(invalidations).toEqual(["workspace-events"]);
    expect(filesDiskGeneration("workspace-events")).toBe(1);
    deleteFilesViewState("workspace-events");
  });

  test("attaches the default and additional Files views", async () => {
    const view = createFilesView("workspace-attach");
    setFilesViewFile("workspace-attach", view.id, "/work/README.md");
    // SAFETY: The test fixture supplies the attachment context field exercised by Files.
    const attachment = await kintsugiServerModule.attachToWorkspace!({ workspaceId: "workspace-attach" } as never);
    expect(attachment.workViews).toHaveLength(2);
    expect(attachment.workViews?.map((view) => view.reference.type)).toEqual(["files", "files"]);
    expect(attachment.workViews?.map((view) => view.initiallyOpen)).toEqual([false, true]);
    deleteFilesViewState("workspace-attach");
  });
});
