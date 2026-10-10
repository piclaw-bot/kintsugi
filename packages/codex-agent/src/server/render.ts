import { parseModelRef } from "@kintsugi/llm/server";
import { renderTranscript } from "@kintsugi/agent/server/render-transcript";
import { ids, type AgentRenderContext } from "@kintsugi/agent/server/render-context";
import { renderAgentPane, renderAgentPaneComposerFooter, renderPromptActions, type AgentStatsView } from "@kintsugi/builtin-agent/server/render-composer";
import type { LiveRegion } from "@kintsugi/shared";
import { projectCodexTurns } from "./transcript.ts";
import type { CodexRuntime } from "./runtime.ts";

export const channelName = "codex-agent";
export function renderContext(runtime: CodexRuntime): AgentRenderContext {
  return { workspaceId: runtime.workspaceId, agentId: runtime.agentId, inlineWorkingItems: true, model: runtime.record.model ? parseModelRef(runtime.record.model) : undefined, transcriptBasePath: `/workspaces/${encodeURIComponent(runtime.workspaceId)}/codex-agents/${encodeURIComponent(runtime.agentId)}` };
}
export function transcriptItems(runtime: CodexRuntime) {
  return [...projectCodexTurns(runtime.state.turns, runtime.state.completedItems), ...runtime.state.notices.map((text, index) => ({ type: "note" as const, key: `notice:${index}`, text, tone: "warning" as const })), ...(runtime.failure ? [{ type: "error" as const, key: "connection-error", text: runtime.failure.message }] : [])];
}
function stats(runtime: CodexRuntime): AgentStatsView {
  const usage = runtime.state.usage;
  const selection = runtime.selection;
  return { contextPercent: usage?.modelContextWindow ? usage.last.totalTokens / usage.modelContextWindow * 100 : null, compactAvailable: !runtime.isBusy, inputTokens: usage?.total.inputTokens ?? null, outputTokens: usage?.total.outputTokens ?? null, cost: null, modelName: runtime.record.model ? parseModelRef(runtime.record.model)?.id : undefined, thinkingLevel: runtime.record.thinkingLevel ?? "", thinkingLevels: selection.thinkingLevels, models: selection.models, connectedProvider: true };
}
export function transcriptHtml(runtime: CodexRuntime) {
  return renderTranscript(renderContext(runtime), transcriptItems(runtime), { systemPrompt: runtime.instructions, tools: [] });
}
export function liveRegions(runtime: CodexRuntime): LiveRegion[] {
  const ctx = renderContext(runtime);
  return [
    { target: ids.transcript(ctx), html: transcriptHtml(runtime) },
    { target: ids.actions(ctx), html: renderPromptActions(ctx, runtime.isBusy) },
    { target: ids.stats(ctx), html: renderAgentPaneComposerFooter(ctx, stats(runtime)), morph: false },
    { target: ids.completionCatalog(ctx), html: runtime.completionCatalog },
  ];
}
export async function paneHtml(runtime: CodexRuntime) {
  await runtime.refreshCompletionCatalog();
  const ctx = renderContext(runtime);
  return renderAgentPane(ctx, { agentId: runtime.agentId }, { transcriptHtml: transcriptHtml(runtime), busy: runtime.isBusy, stats: stats(runtime) }, runtime.completionCatalog, { moduleChannel: channelName, notifications: false, initialPromptDraft: false });
}
