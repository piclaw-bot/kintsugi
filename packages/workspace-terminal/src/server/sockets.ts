import { KintsugiCoreError } from "@kintsugi/core";
import { createObservableTerminalSocket, terminalSocketDimensions } from "@kintsugi/observable-terminal/server";
import type { WorkspaceServerSocketHandler } from "@kintsugi/shared";
import { workspaceContainerName, workspaceRoot } from "@kintsugi/workspace";
import { terminalIdFromViewKey } from "../shared.ts";
import { listWorkspaceTerminals } from "./workspace-terminals.ts";

export function createTerminalSocketHandler(): WorkspaceServerSocketHandler {
  return async (url) => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/views\/([^/]+)\/ws$/);
    if (!match) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const terminalId = terminalIdFromViewKey(decodeURIComponent(match[2]!));
    if (!terminalId) return undefined;
    const terminal = (await listWorkspaceTerminals(workspaceId)).find((item) => item.id === terminalId);
    if (!terminal) throw new KintsugiCoreError("terminal_not_found", `terminal not found: ${terminalId}`);
    return createObservableTerminalSocket({
      containerName: workspaceContainerName(workspaceId),
      session: terminal.tmuxSession,
      requireExistingServer: true,
      reportSessionMissing: true,
      ...terminalSocketDimensions(url),
      user: "agent",
      workdir: workspaceRoot,
    });
  };
}
