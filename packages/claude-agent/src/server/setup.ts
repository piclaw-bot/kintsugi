import { kintsugiSystemPrompt } from "@kintsugi/agent/server/system-prompt";
import { prepareCliAgentConnection } from "@kintsugi/agent/server";
import { checkedWorkspaceShell, cliLaunchScript, createCliModelSettings, writeCliSessionFiles } from "@kintsugi/cli-agent/server";
import { createPiModelRuntime, installClaudeSubscriptionAuth, requireProviderSubscription } from "@kintsugi/llm/server";
import { loadWorkspaceAgentsFiles } from "@kintsugi/builtin-agent/server/workspace-agents-files";

export const agentTypeId = "claude";
export const label = "Claude Code";
// The executable and @anthropic-ai/claude-agent-sdk 0.3.296 are released and pinned together.
export const claudeCodeVersion = "2.1.296";
export const claudeExecutable = `/home/agent/.claude-cli/${claudeCodeVersion}/node_modules/.bin/claude`;
export const settings = createCliModelSettings({
  agentTypeId, provider: "anthropic", label,
  mapThinkingLevel: (level, mapped) => mapped !== null && ["low", "medium", "high", "xhigh", "max"].includes(mapped ?? level) ? mapped ?? level : undefined,
});
export async function requireSetup() {
  await requireProviderSubscription(await createPiModelRuntime(), "anthropic", "Claude");
}
function claudeAgentDirectory(agentId: string) { return `/home/agent/.local/share/kintsugi-agents/${agentId}`; }
/** Claude's own config directory for this Agent, so its conversations stay apart from the Claude Code CLI's. */
export function claudeConfigDirectory(agentId: string) { return `${claudeAgentDirectory(agentId)}/claude`; }
/** Session-private MCP configuration; the bearer token never reaches a command line. */
export function claudeMcpConfigPath(agentId: string) { return `${claudeAgentDirectory(agentId)}/claude-mcp.json`; }

/** Claude Code's own prompt assumes a terminal. This Agent renders its replies. */
export const renderedTranscriptInstructions = "Your replies are rendered as rich Markdown in Kintsugi's web transcript, not in a terminal. Where Claude Code's guidance about terminal output conflicts with this, follow Kintsugi's guidance.";

export async function prepareClaude(workspaceId: string, agentId: string): Promise<{ instructions: string }> {
  await installClaudeSubscriptionAuth(workspaceId, claudeConfigDirectory(agentId), await createPiModelRuntime());
  const connection = await prepareCliAgentConnection(workspaceId, agentId, kintsugiSystemPrompt);
  // Claude Code discovers CLAUDE.md natively but not AGENTS.md, so all of them are appended.
  const files = await loadWorkspaceAgentsFiles(workspaceId);
  const instructions = [connection.instructions, renderedTranscriptInstructions, ...files.map(file => `# Project instructions: ${file.path}\n\n${file.content}`)].join("\n\n");
  // Claude waits for alwaysLoad servers at startup and includes their tools in turn one.
  const mcp = { mcpServers: { "kintsugi": { type: "http", url: connection.url, headers: { Authorization: `Bearer ${connection.token}` }, alwaysLoad: true } } };
  await writeCliSessionFiles(workspaceId, { directory: claudeAgentDirectory(agentId) }, { "claude-mcp.json": JSON.stringify(mcp) });
  await checkedWorkspaceShell(workspaceId, cliLaunchScript({ executable: "claude", label, npmPackage: "@anthropic-ai/claude-code", version: claudeCodeVersion, args: ["--version"] }));
  return { instructions };
}
