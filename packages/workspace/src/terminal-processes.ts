import { createTerminalProcesses, type TerminalProcesses } from "@kintsugi/observable-terminal/server";
import { runInWorkspace, startInWorkspace } from "./helper.ts";

/** In the agent's home, so the workspace keeps results across app restarts until they are released. */
const terminalProcessesRoot = "/home/agent/.local/state/kintsugi/terminal-processes";

/** Terminal processes in one workspace, run through its helper. */
export function workspaceTerminalProcesses(workspaceId: string): TerminalProcesses {
  return createTerminalProcesses({
    root: terminalProcessesRoot,
    run: (start, options) => runInWorkspace(workspaceId, start, options),
    start: (start) => startInWorkspace(workspaceId, start),
  });
}
