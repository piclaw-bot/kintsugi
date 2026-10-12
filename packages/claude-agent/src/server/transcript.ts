import type { ToolView, TranscriptItem, WorkingTranscriptItem } from "@kintsugi/agent/server/transcript";
import { claudeToolCall } from "@kintsugi/claude-cli-agent/transcript";
import { claudeImageSources, claudeText, claudeUserIntent, type ClaudeBlock } from "./rows.ts";
import type { ClaudeState } from "./state.ts";

function resultText(block: ClaudeBlock): string {
  if (!Array.isArray(block.content)) return block.content ?? "";
  return block.content.filter(part => part.type === "text").map(part => part.text ?? "").filter(Boolean).join("\n");
}

/** Claude retries failed requests itself and records an error only once it gives up, ending the turn. */
interface Turn { prompt?: TranscriptItem; working: WorkingTranscriptItem; endedAt: number; interrupted: boolean; error?: TranscriptItem; live: boolean }

/** Claude rows and the block it is streaming, grouped like every other Agent's turns. */
export function projectClaudeTranscript(state: Pick<ClaudeState, "rows" | "streaming">, busy: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, ToolView>();
  const positions = new Map<string, number>();
  let turn: Turn | undefined;
  const finish = () => {
    if (!turn) return;
    const { working } = turn;
    // The last reply after its final tool call answers the prompt; earlier text was commentary.
    const index = working.items.findLastIndex(item => item.type !== "note");
    const final = !turn.live && !turn.error && working.items[index]?.type === "text" ? working.items.splice(index, 1)[0] : undefined;
    if (final?.type === "text") final.final = true;
    working.hasFinalAnswer = Boolean(final);
    working.live = turn.live;
    if (!turn.live) {
      if (turn.interrupted || turn.error) working.stoppedAt = turn.endedAt;
      else working.completedAt = turn.endedAt;
    }
    items.push(...turn.prompt ? [turn.prompt] : [], working, ...final ? [final] : [], ...turn.error ? [turn.error] : []);
    turn = undefined;
  };
  const activity = (item: TranscriptItem, timestamp: number) => {
    if (!turn) { items.push(item); return; }
    turn.working.items.push(item);
    turn.endedAt = Math.max(turn.endedAt, timestamp);
  };
  const assistantBlock = (block: { type: string; text: string; id?: string; name?: string; input?: unknown }, key: string, timestamp: number, live: boolean) => {
    if (block.type === "thinking") {
      if (block.text.trim()) activity({ type: "thinking", key, text: block.text, live }, timestamp);
    } else if (block.type === "text") {
      if (block.text.trim()) activity({ type: "text", key, text: block.text, final: false, live }, timestamp);
    } else if (block.type === "tool_use" && block.id) {
      const call = claudeToolCall({ name: block.name, input: block.input });
      const tool: ToolView = { callId: block.id, name: call.name, args: call.args ?? {}, status: live ? "streaming" : "running", issuedAt: timestamp };
      tools.set(block.id, tool);
      activity({ type: "tool", key: `tool:${block.id}`, tool }, timestamp);
    }
  };
  const rows = state.rows;
  // Claude records a manual compaction before the /compact command that caused it.
  let compaction: TranscriptItem | undefined;
  // A control command's output, such as "Set model to …", already shows in the footer.
  let controlOutput = false;
  rows.forEach((row, index) => {
    if (row.kind === "user") {
      const intent = claudeUserIntent(row);
      if (intent?.kind === "prompt") {
        finish();
        const live = busy && !rows.slice(index + 1).some(next => next.kind === "user" && claudeUserIntent(next)?.kind === "prompt");
        turn = { prompt: { type: "user", key: row.uuid, text: intent.text, images: intent.images }, working: { type: "working", key: `${row.uuid}:working`, startedAt: row.timestamp, items: compaction ? [compaction] : [] }, endedAt: row.timestamp, interrupted: false, live };
        compaction = undefined;
      } else if (intent?.kind === "control") controlOutput = true;
      else if (intent?.kind === "output" && controlOutput) controlOutput = false;
      else if (intent?.kind === "output") activity({ type: "note", key: `${row.uuid}:output`, text: intent.text, tone: "system" }, row.timestamp);
      else if (intent?.kind === "interrupted" && turn) { turn.interrupted = true; turn.endedAt = Math.max(turn.endedAt, row.timestamp); }
      for (const block of row.content) {
        const tool = block.type === "tool_result" && block.tool_use_id ? tools.get(block.tool_use_id) : undefined;
        if (!tool) continue;
        tool.status = block.is_error ? "error" : "ok";
        tool.resultText = resultText(block);
        const images = claudeImageSources([block]);
        if (images.length) {
          const offset = claudeImageSources(row.content.slice(0, row.content.indexOf(block))).length;
          tool.resultImages = images.map((source, imageIndex) => ({ entryId: row.uuid, contentIndex: offset + imageIndex, mimeType: source.media_type }));
        }
        if (tool.issuedAt) tool.durationMs = Math.max(0, row.timestamp - tool.issuedAt);
        if (turn) turn.endedAt = Math.max(turn.endedAt, row.timestamp);
      }
    } else if (row.kind === "assistant") {
      if (row.error) {
        const error: TranscriptItem = { type: "error", key: `${row.uuid}:error`, text: claudeText(row.content) || "Claude could not reply." };
        if (!turn) { items.push(error); return; }
        turn.error = error;
        turn.endedAt = Math.max(turn.endedAt, row.timestamp);
        return;
      }
      let position = positions.get(row.messageId) ?? 0;
      for (const block of row.content) assistantBlock({ ...block, text: block.thinking ?? block.text ?? "" }, `${row.messageId}:${position++}`, row.timestamp, false);
      positions.set(row.messageId, position);
    } else if (row.kind === "steer") {
      activity({ type: "user", key: row.uuid, text: row.text, images: [], steering: true }, row.timestamp);
    } else if (row.kind === "compact") {
      const note: TranscriptItem = { type: "note", key: row.uuid, text: "Claude compacted the conversation.", tone: "summary" };
      const next = rows.slice(index + 1).find(next => next.kind === "assistant" || (next.kind === "user" && claudeUserIntent(next)?.kind === "prompt"));
      if (next?.kind === "user" && claudeUserIntent(next)?.text?.startsWith("/compact")) compaction = note;
      else activity(note, row.timestamp);
    }
  });
  const streaming = state.streaming;
  if (streaming) for (const [index, block] of [...streaming.blocks].sort(([left], [right]) => left - right)) {
    assistantBlock(block, `${streaming.messageId}:${index}`, streaming.startedAt, true);
  }
  finish();
  // Tool calls of a finished turn that never reported a result were cut short.
  for (const tool of tools.values()) if ((tool.status === "running" || tool.status === "streaming") && !busy) tool.status = "error";
  return items;
}
