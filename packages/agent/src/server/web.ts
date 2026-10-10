import { dockerHostKintsugiDataPath, getKintsugiRuntimeContext, type KintsugiEventBus } from "@kintsugi/core";
import { markdownMathStaticFiles } from "@kintsugi/markdown/assets";
import type { WorkspaceModule } from "@kintsugi/shared";
import { observableTerminalStaticFiles } from "@kintsugi/observable-terminal/server";
import { workspacePortBackend, type WorkspaceDockerMount, type WorkspaceInitInstruction } from "@kintsugi/workspace";
import { mkdir } from "node:fs/promises";
import { createAgentTermSocketSession } from "./bash-tmux.ts";
import { sessionShareDir, sessionShareKeyForInit, sessionShareMountPath } from "./session-share.ts";
import { createDeleteCurrentWorkspaceTool, registerWorkspaceAgentTool } from "./tools.ts";
import { usageOpenApiPaths } from "./usage-openapi.ts";
import { handleUsageRequest, renderUsagePaneAction } from "./usage-web.ts";
import { workspaceFileEndpoint } from "./workspace-files.ts";
import { subscribeWorkspaceAgentBusy } from "./workspace-agent-busy.ts";

type WorkspacePlanEvents = {
  on(eventName: "workspace_plan_prepare", handler: (event: { init?: WorkspaceInitInstruction; plan: { mounts: WorkspaceDockerMount[] } }) => void | Promise<void>): void;
};

function dockerHostSessionShareDir(shareKey: string): string {
  return dockerHostKintsugiDataPath(getKintsugiRuntimeContext(), "session-shares", shareKey);
}

function registerSessionShareMountEvents(events: KintsugiEventBus): void {
  // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
  (events as WorkspacePlanEvents).on("workspace_plan_prepare", async ({ init, plan }) => {
    const shareKey = sessionShareKeyForInit(init);
    await mkdir(sessionShareDir(shareKey), { recursive: true });
    plan.mounts.push({ type: "bind", source: dockerHostSessionShareDir(shareKey), target: sessionShareMountPath, readonly: true });
  });
}

export const agentWorkspaceModule: WorkspaceModule = {
  id: "agent",
  staticFiles: {
    "/agent-usage.css": { url: new URL("../client/usage.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    "/agent.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    "/agent-tree.css": { url: new URL("../client/tree.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    ...observableTerminalStaticFiles,
    ...markdownMathStaticFiles,
  },
  renderWorkspacePaneActions: renderUsagePaneAction,
  openApiPaths: usageOpenApiPaths,
  routes: [{ handle: handleUsageRequest }],
  initialize(context) {
    registerSessionShareMountEvents(context.events);
    context.registerSocketHandler(createAgentTermSocketSession);
    context.registerWorkspaceAppResolver(async (app, requestUrl) => {
      if (app.appKey === "file") return {
        kind: "fetch",
        fetch: (request) => workspaceFileEndpoint(app.workspaceId, decodeURIComponent(new URL(request.url).pathname), request),
      };
      const portMatch = app.appKey.match(/^port-(\d+)$/);
      if (!portMatch) return undefined;
      return await workspacePortBackend(app.workspaceId, Number(portMatch[1]), `${requestUrl.pathname}${requestUrl.search}`);
    });
    subscribeWorkspaceAgentBusy(({ workspaceId, agentKey, busy }) => context.registry.setAgentBusy(workspaceId, agentKey, busy));
    registerWorkspaceAgentTool("delete_current_workspace", (workspaceId) => createDeleteCurrentWorkspaceTool(workspaceId, async (force) => await context.deleteCurrentWorkspace(workspaceId, force)));
  },
};
