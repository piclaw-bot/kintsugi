import { parseModelRef } from "@kintsugi/llm/server";
import { renderTranscript } from "@kintsugi/agent/server/render-transcript";
import { ids, type AgentRenderContext } from "@kintsugi/agent/server/render-context";
import type { TranscriptItem } from "@kintsugi/agent/server/transcript";
import { renderAgentPane, renderAgentPaneComposerFooter, renderPromptActions, type AgentStatsView } from "@kintsugi/builtin-agent/server/render-composer";
import type { LiveRegion } from "@kintsugi/shared";
import type { NativeAgentRuntime } from "./agents.ts";

/** A native Agent's pane: its projected transcript, then notices and a lost connection. */
export function createNativeAgentRendering<Runtime extends NativeAgentRuntime>(options: {
  channelName: string;
  /** Path segment under the workspace for this Agent type's routes, such as `codex-agents`. */
  routeSegment: string;
  transcript(runtime: Runtime): TranscriptItem[];
  stats(runtime: Runtime): AgentStatsView;
}) {
  function renderContext(runtime: Runtime): AgentRenderContext {
    return { workspaceId: runtime.workspaceId, agentId: runtime.agentId, inlineWorkingItems: true, lazyCompletedWorkingItems: true, model: runtime.record.model ? parseModelRef(runtime.record.model) : undefined, transcriptBasePath: `/workspaces/${encodeURIComponent(runtime.workspaceId)}/${options.routeSegment}/${encodeURIComponent(runtime.agentId)}` };
  }
  function transcriptItems(runtime: Runtime): TranscriptItem[] {
    return [
      ...options.transcript(runtime),
      ...runtime.state.notices.map((text, index) => ({ type: "note" as const, key: `notice:${index}`, text, tone: "warning" as const })),
      ...runtime.failure ? [{ type: "error" as const, key: "connection-error", text: runtime.failure.message }] : [],
    ];
  }
  function transcriptHtml(runtime: Runtime) {
    return renderTranscript(renderContext(runtime), transcriptItems(runtime), { systemPrompt: runtime.instructions, tools: [] });
  }
  function liveRegions(runtime: Runtime): LiveRegion[] {
    const ctx = renderContext(runtime);
    return [
      { target: ids.transcript(ctx), html: transcriptHtml(runtime) },
      { target: ids.actions(ctx), html: renderPromptActions(ctx, runtime.isBusy) },
      { target: ids.stats(ctx), html: renderAgentPaneComposerFooter(ctx, options.stats(runtime)), morph: false },
      { target: ids.completionCatalog(ctx), html: runtime.completionCatalog },
    ];
  }
  async function paneHtml(runtime: Runtime) {
    await runtime.refreshCompletionCatalog();
    const ctx = renderContext(runtime);
    return renderAgentPane(ctx, { agentId: runtime.agentId }, { transcriptHtml: transcriptHtml(runtime), busy: runtime.isBusy, stats: options.stats(runtime) }, runtime.completionCatalog, { moduleChannel: options.channelName, notifications: false, subagents: false, initialPromptDraft: false });
  }
  return { channelName: options.channelName, routeSegment: options.routeSegment, renderContext, transcriptItems, liveRegions, paneHtml };
}
export type NativeAgentRendering<Runtime extends NativeAgentRuntime> = ReturnType<typeof createNativeAgentRendering<Runtime>>;
