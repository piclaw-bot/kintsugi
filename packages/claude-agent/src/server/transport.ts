import { spawn } from "node:child_process";
import { query, type EffortLevel, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolveWorkspace, workspaceContainerName, workspaceRoot } from "@kintsugi/workspace";
import { claudeConfigDirectory, claudeExecutable, claudeMcpConfigPath } from "./setup.ts";

/** Which native conversation the process continues. A fork resumes `resume` into the new `sessionId`. */
type ClaudeSessionStart = { sessionId: string; resume?: string; forkSession?: boolean };

/** Prompts stay open for the life of the process; Claude queues those sent while it works. */
function inputQueue() {
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (pending.length) yield pending.shift()!;
      if (ended) return;
      await new Promise<void>(resolve => wake = resolve);
    }
  }
  return {
    messages: messages(),
    push(message: SDKUserMessage) { pending.push(message); wake?.(); },
    end() { ended = true; wake?.(); },
  };
}

/** Stdio stays private: no listening port or raw provider credential in a workspace. */
export async function openClaudeTransport(workspaceId: string, agentId: string, start: ClaudeSessionStart & { instructions: string; model?: string; effort?: EffortLevel }, message: (message: SDKMessage) => void, failed: (error: Error) => void) {
  const container = workspaceContainerName(workspaceId);
  await resolveWorkspace(workspaceId);
  const input = inputQueue();
  let stderr = "";
  let closing = false;
  const options: Options = {
    // The process runs in the workspace; nothing from Kintsugi's own environment may reach it.
    env: { CLAUDE_AGENT_SDK_CLIENT_APP: "kintsugi", CLAUDE_CONFIG_DIR: claudeConfigDirectory(agentId) },
    cwd: workspaceRoot,
    pathToClaudeCodeExecutable: claudeExecutable,
    spawnClaudeCodeProcess(options) {
      const environment = Object.entries(options.env).flatMap(([name, value]) => value === undefined ? [] : ["--env", `${name}=${value}`]);
      const child = spawn("docker", ["exec", "-i", "--user", "agent", "--workdir", workspaceRoot, "--env", "HOME=/home/agent", ...environment, container, claudeExecutable, ...options.args], { stdio: ["pipe", "pipe", "pipe"], signal: options.signal });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16000); });
      return child;
    },
    extraArgs: { "mcp-config": claudeMcpConfigPath(agentId) },
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code", append: start.instructions },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // No client surface answers these yet; Claude asks in its reply instead.
    disallowedTools: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
    includePartialMessages: true,
    thinking: { type: "adaptive", display: "summarized" },
    model: start.model,
    effort: start.effort,
  };
  if (!start.resume) options.sessionId = start.sessionId;
  else {
    options.resume = start.resume;
    if (start.forkSession) { options.forkSession = true; options.sessionId = start.sessionId; }
  }
  const native = query({ prompt: input.messages, options });
  const reading = (async () => {
    try {
      for await (const value of native) message(value);
      if (!closing) failed(new Error(`Claude Code exited${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    } catch (error) {
      if (closing) return;
      const reason = error instanceof Error ? error.message : String(error);
      failed(new Error(stderr.trim() ? `${reason}: ${stderr.trim()}` : reason));
    }
  })();
  return {
    query: native,
    send(value: SDKUserMessage) { input.push(value); },
    async close() {
      closing = true;
      input.end();
      native.close();
      await reading;
    },
  };
}
export type ClaudeTransport = Awaited<ReturnType<typeof openClaudeTransport>>;
