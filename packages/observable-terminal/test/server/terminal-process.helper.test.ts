import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGoProgram } from "@kintsugi/core";
import { closeWorkspaceHelper, runWorkspaceProcess, startWorkspaceProcess } from "@kintsugi/workspace-helper";
import { describeTerminalProcesses } from "./terminal-process-scenarios.ts";

/** The same scenarios through a real helper, which runs as root and starts processes as the agent's user. */
describeTerminalProcesses("terminal processes through the workspace helper", async (tmuxDirectory) => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-process-helper-"));
  const binary = join(directory, "kintsugi-workspace-helper");
  await buildGoProgram(fileURLToPath(new URL("../../../workspace-helper/helper", import.meta.url)), binary, `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`);
  const socket = join(directory, "helper.sock");
  const state = join(directory, "state");
  const helper = Bun.spawn(["sudo", "-n", binary, "--allow-unauthenticated", "--listen", socket, "--state", state], { stdout: "inherit", stderr: "pipe" });
  // The helper logs once it listens. Reading on afterwards keeps its later log lines from hitting a closed pipe.
  const stderr = helper.stderr.pipeThrough(new TextDecoderStream()).getReader();
  let log = "";
  while (!log.includes("listening on")) {
    const { done, value } = await stderr.read();
    if (done) throw new Error(`The helper did not start: ${log}`);
    log += value;
  }
  void (async () => { while (!(await stderr.read()).done); })();
  return {
    async run(start, options) {
      const result = await runWorkspaceProcess(socket, { ...start, env: { ...start.env, TMUX_TMPDIR: tmuxDirectory } }, options);
      return { ...result, stderr: result.stderr.toString() };
    },
    start: (start) => startWorkspaceProcess(socket, { ...start, env: { ...start.env, TMUX_TMPDIR: tmuxDirectory } }),
    async close() {
      closeWorkspaceHelper(socket);
      helper.kill();
      await helper.exited;
      // The helper keeps its state as root.
      await Bun.spawn(["sudo", "-n", "rm", "-rf", directory]).exited;
    },
  };
});
