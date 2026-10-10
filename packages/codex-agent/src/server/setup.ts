import { kintsugiSystemPrompt } from "@kintsugi/agent/server/system-prompt";
import { prepareCliAgentConnection } from "@kintsugi/agent/server";
import { checkedWorkspaceShell, cliLaunchScript, createCliModelSettings } from "@kintsugi/cli-agent/server";
import { createPiModelRuntime, installCodexSubscriptionAuth, requireProviderSubscription } from "@kintsugi/llm/server";
import { loadWorkspaceAgentsFiles } from "@kintsugi/builtin-agent/server/workspace-agents-files";
import { codexVersion } from "./protocol.ts";

export const agentTypeId = "codex";
export const label = "Codex";
export const settings = createCliModelSettings({ agentTypeId, provider: "openai-codex", label: "Codex", mapThinkingLevel: (level, mapped) => mapped === null ? undefined : mapped ?? (level === "off" ? "none" : level) });
export async function requireSetup() {
  await requireProviderSubscription(await createPiModelRuntime(), "openai-codex", "Codex");
}
export function codexHome(agentId: string) { return `/home/agent/.local/share/kintsugi-agents/${agentId}/codex`; }

export async function prepareCodex(workspaceId: string, agentId: string): Promise<{ instructions: string; mcp: { url: string; token: string } }> {
  await installCodexSubscriptionAuth(workspaceId, codexHome(agentId), await createPiModelRuntime());
  const connection = await prepareCliAgentConnection(workspaceId, agentId, kintsugiSystemPrompt);
  // Codex keeps its base coding prompt, AGENTS.md discovery and native tools.
  // Only the renderer-aware application guidance and plugin instructions differ.
  const files = await loadWorkspaceAgentsFiles(workspaceId, { includeRoot: false });
  const instructions = [connection.instructions, ...files.map(file => `# Project instructions: ${file.path}\n\n${file.content}`)].join("\n\n");
  // Connection overrides belong to this process, not the native settings file.
  // Codex owns config.toml so skill, plugin and app changes survive reconnects.
  await checkedWorkspaceShell(workspaceId, cliLaunchScript({ executable: "codex", label: "Codex", npmPackage: "@openai/codex", version: codexVersion, args: ["--version"] }));
  return { instructions, mcp: { url: connection.url, token: connection.token } };
}
