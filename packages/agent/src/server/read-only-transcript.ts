import type { AgentRenderContext } from "./render-context.ts";
import { renderIdleSeparator, renderTranscriptItem, renderTranscriptItemDetailFrame } from "./render-transcript.ts";
import { buildTranscript, findTranscriptItem, type TranscriptRecord } from "./transcript.ts";

/** External agent history shares the transcript presentation, not the built-in agent runtime. */
export function renderReadOnlyTranscript(ctx: AgentRenderContext, records: TranscriptRecord[], options: { idle?: boolean } = {}): string {
  const view = { ...ctx, readOnly: true };
  const items = buildTranscript(records);
  return items.map((item) => renderTranscriptItem(view, item)).join("") + (options.idle ? renderIdleSeparator(items, false) : "");
}

export function renderReadOnlyTranscriptDetail(ctx: AgentRenderContext, records: TranscriptRecord[], key: string, count: number): string | undefined {
  const item = findTranscriptItem(buildTranscript(records), key);
  return item ? renderTranscriptItemDetailFrame({ ...ctx, readOnly: true }, item, { count }) : undefined;
}
