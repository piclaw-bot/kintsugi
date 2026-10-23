import { runLocally, startLocally } from "../support/local-terminal-processes.ts";
import { describeTerminalProcesses } from "./terminal-process-scenarios.ts";

describeTerminalProcesses("terminal processes", async (tmuxDirectory) => ({ run: runLocally(tmuxDirectory), start: startLocally(tmuxDirectory), async close() {} }));
