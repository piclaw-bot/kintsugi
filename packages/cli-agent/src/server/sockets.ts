import { KintsugiCoreError } from "@kintsugi/core";
import { createObservableTerminalSocket, terminalSocketDimensions } from "@kintsugi/observable-terminal/server";
import type { WorkspaceServerSocketHandler } from "@kintsugi/shared";
import { workspaceContainerName, workspaceRoot } from "@kintsugi/workspace";
import type { CliAgents } from "./agents.ts";

export function cliSocketHandler(providerId: string, agents: CliAgents): WorkspaceServerSocketHandler {
  return async (url) => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)\/([^/]+)\/ws$/);
    if (!match || match[2] !== `${providerId}-agents`) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const session = await agents.ready(workspaceId, decodeURIComponent(match[3]!));
    if (session.error) throw new KintsugiCoreError("agent_session_failed", session.error);
    return createObservableTerminalSocket({
      containerName: workspaceContainerName(workspaceId), session: session.tmuxSession,
      ...terminalSocketDimensions(url),
      user: "agent", workdir: workspaceRoot, readonly: false,
    });
  };
}
