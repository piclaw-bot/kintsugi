import { parseModelRef } from "@kintsugi/llm/server";
import { cliLaunchScript, cliPromptText, turnSignalShell, writeFileScript, type CliAgentSession, type CliModelSettings, type TurnBoundary } from "@kintsugi/cli-agent/server";
import { claudeInstructionsPath, claudeMcpConfigPath } from "./session.ts";
import { shellQuote } from "@kintsugi/core";
import { workspaceRoot } from "@kintsugi/workspace";
import type { WorkspaceAgentInput } from "@kintsugi/shared";
import { readThemeSetting } from "@kintsugi/shared/theme";
import { claudeKintsugiTheme, claudeThemeName } from "./theme.ts";

function turnBoundaryHooks(turnSignalCommand: string) {
  const hook = (boundary: TurnBoundary) => [{ hooks: [{ type: "command", command: turnSignalShell(turnSignalCommand, boundary) }] }];
  return { UserPromptSubmit: hook("started"), Stop: hook("finished"), StopFailure: hook("failed") };
}

/** Run inside tmux so installation progress and failures stay visible in the tab. */
export function claudeLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings, session: CliAgentSession, resume = false): string {
  // Claude has no --image flag. Its Read tool opens the materialized images.
  const prompt = cliPromptText(input, imagePaths.map((path) => `Read the attached image at ${JSON.stringify(path)}.`));
  const cliSettings = {
    skipDangerousModePermissionPrompt: true,
    theme: `custom:${claudeThemeName}`,
    hooks: turnBoundaryHooks(session.turnSignalCommand),
  };
  // Added to whatever MCP servers the user configured; Claude merges both sets.
  const args = ["--dangerously-skip-permissions", "--settings", JSON.stringify(cliSettings), "--append-system-prompt-file", claudeInstructionsPath(session), "--mcp-config", claudeMcpConfigPath(session),
    resume ? "--resume" : "--session-id", session.id,
    ...(settings.model ? ["--model", parseModelRef(settings.model)!.id] : []),
    ...(settings.thinkingLevel ? ["--effort", settings.thinkingLevel] : []), ...(prompt ? ["--", prompt] : [])];
  // The subscription is already connected in Kintsugi. Preserve other CLI preferences.
  const configure = `const fs = require("node:fs");
const path = require("node:path").join(require("node:os").homedir(), ".claude.json");
const config = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
config.installMethod = "local";
config.autoUpdates = true;
config.hasCompletedOnboarding = true;
config.projects ??= {};
config.projects[${JSON.stringify(workspaceRoot)}] = { ...config.projects[${JSON.stringify(workspaceRoot)}], hasTrustDialogAccepted: true };
const temporary = path + ".kintsugi-" + process.pid;
fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
fs.renameSync(temporary, path);`;
  return cliLaunchScript({
    // Claude recognizes this path as npm-local and updates it in place. An arbitrary
    // npm prefix is detected as global, making updates target unwritable /usr/local.
    installDirectory: ".claude/local",
    executable: "claude", label: "Claude Code", npmPackage: "@anthropic-ai/claude-code", args,
    setup: `(
  flock 8
  node -e ${shellQuote(configure)}
) 8> "$HOME/.claude-config-setup.lock"
${writeFileScript(`"$HOME/.claude/themes/${claudeThemeName}.json"`, JSON.stringify(claudeKintsugiTheme(readThemeSetting()), null, 2))}`,
  });
}
