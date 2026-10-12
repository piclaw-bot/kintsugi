import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { escapeHtml, providerBrandIconHtml } from "@kintsugi/shared";

interface AgentTypeChoice { id: string; label: string; iconHtml: string }

const agentOrder = ["builtin", "pi", "claude", "claude-cli", "codex", "codex-cli"];
const flexibleSubscriptions = [
  { provider: "openai", label: "ChatGPT" },
  { provider: "github-copilot", label: "GitHub Copilot" },
  { provider: "xai", label: "xAI" },
  { provider: "kimi-coding", label: "Kimi" },
];
const openAISubscription = [{ provider: "openai", label: "ChatGPT" }];
const claudeSubscription = [{ provider: "anthropic", label: "Claude" }];
interface AgentDescription { what: string; models: string; subscriptions: typeof flexibleSubscriptions }
const descriptions = new Map<string, AgentDescription>([
  ["builtin", { what: "Lucas' favorite! Pi Durable + Best Visualizations", models: "All", subscriptions: flexibleSubscriptions }],
  ["pi", { what: "Original Pi CLI", models: "All", subscriptions: flexibleSubscriptions }],
  ["claude", { what: "Claude Code harness with HTML composer and transcript", models: "Anthropic", subscriptions: claudeSubscription }],
  ["claude-cli", { what: "Original Claude Code CLI", models: "Anthropic", subscriptions: claudeSubscription }],
  ["codex", { what: "Codex harness with HTML composer and transcript", models: "OpenAI", subscriptions: openAISubscription }],
  ["codex-cli", { what: "Original Codex CLI", models: "OpenAI", subscriptions: openAISubscription }],
]);

function orderedAgentTypes<T extends AgentTypeChoice>(agentTypes: readonly T[]): T[] {
  return agentTypes.toSorted((a, b) => agentOrder.indexOf(a.id) - agentOrder.indexOf(b.id));
}

/** Shared comparison rows; callers retain ownership of selection forms and actions. */
export function renderAgentTypePicker(agentTypes: readonly AgentTypeChoice[], options: {
  attributes: (agentType: AgentTypeChoice) => string;
}): string {
  const rows = orderedAgentTypes(agentTypes).map(agentType => {
    const description = descriptions.get(agentType.id)!;
    const subscriptions = description.subscriptions.map(({ provider, label }) => `<span class="agent-type-subscription" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)} subscription">${providerBrandIconHtml(provider, label)}</span>`).join("");
    const row = contentRowHtml({
      kind: "multiline", width: "fill", label: { kind: "text", text: agentType.label }, leadingHtml: agentType.iconHtml,
      trailingHtml: `<span class="agent-type-fields"><span class="agent-type-what">${escapeHtml(description.what)}</span><span>${description.models}</span><span class="agent-type-subscriptions">${subscriptions}</span></span>`,
      element: { tag: "button", attributesHtml: options.attributes(agentType) },
    });
    return `<div class="agent-type-choice">${row}</div>`;
  }).join("");
  return `<div class="agent-type-picker"><div class="agent-type-picker-header" aria-hidden="true"><span>Agent</span><span>What</span><span>Models</span><span>Subscriptions</span></div>${rows}</div>`;
}
