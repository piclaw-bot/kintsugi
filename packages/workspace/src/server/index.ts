import { ensureSharedHome } from "../home.ts";
import { fileURLToPath } from "node:url";
import { prepareWorkspaceToolsMount } from "./workspace-tools.ts";
import { syncWorkspaceDocs } from "./workspace-docs.ts";
import {
  kintsugiDataPath,
  dockerHostKintsugiDataPath,
  getKintsugiRuntimeContext,
} from "@kintsugi/core";
import type { WorkspaceModule, WorkspaceServerSocketHandler } from "@kintsugi/shared";
import { clearAppTerminalProcesses, appTerminalProcesses, terminalSocketDimensions } from "@kintsugi/observable-terminal/server";
import { workspaceTerminalProcesses } from "../terminal-processes.ts";

/**
 * Viewers of every terminal process connect here: those in a workspace, such as
 * Terminal views and Agents' bash calls, and those on the app's machine, such as provisioning's.
 */
const terminalProcessSocket: WorkspaceServerSocketHandler = (url) => {
  const inWorkspace = url.pathname.match(/^\/workspaces\/([^/]+)\/terminal-processes\/([^/]+)\/ws$/);
  if (inWorkspace) return workspaceTerminalProcesses(decodeURIComponent(inWorkspace[1]!)).connect(decodeURIComponent(inWorkspace[2]!), terminalSocketDimensions(url));
  const ofApp = url.pathname.match(/^\/terminal-processes\/([^/]+)\/ws$/);
  if (ofApp) return appTerminalProcesses().connect(decodeURIComponent(ofApp[1]!), terminalSocketDimensions(url));
  return undefined;
};

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const docsMountPath = "/opt/kintsugi/docs";

export const kintsugiServerModule: WorkspaceModule = {
  id: "workspace",
  async initialize({ events, registerSocketHandler }) {
    // Provisioning never outlives the app; whatever the last one left is gone.
    await clearAppTerminalProcesses();
    registerSocketHandler(terminalProcessSocket);
    await ensureSharedHome();
    const runtime = getKintsugiRuntimeContext();
    await syncWorkspaceDocs(repositoryRoot, kintsugiDataPath(runtime, "docs"));
    const toolsMount = await prepareWorkspaceToolsMount(runtime);
    events.on("workspace_plan_prepare", ({ plan }) => {
      plan.mounts.push(toolsMount);
      if (plan.mounts.some((mount) => mount.target === docsMountPath)) return;
      plan.mounts.push({
        type: "bind",
        source: dockerHostKintsugiDataPath(runtime, "docs"),
        target: docsMountPath,
        readonly: true,
      });
    });
  },
};
