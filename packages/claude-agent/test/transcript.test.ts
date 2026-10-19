import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, JsonValue } from "@kintsugi/core";
import { claudeRows } from "../src/server/rows.ts";
import { ClaudeState } from "../src/server/state.ts";
import { projectClaudeTranscript } from "../src/server/transcript.ts";

const time = (second: number) => `2026-10-12T12:00:${String(second).padStart(2, "0")}.000Z`;
const user = (uuid: string, second: number, content: JsonValue, extra: JsonObject = {}) => ({ type: "user", uuid, timestamp: time(second), message: { role: "user", content }, ...extra });
const assistant = (uuid: string, second: number, id: string, content: JsonValue[], stop_reason: string | null = null) => ({ type: "assistant", uuid, timestamp: time(second), message: { id, content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } } });
const jsonl = (...rows: JsonObject[]) => rows.map(row => JSON.stringify(row)).join("\n");
// SAFETY: Fixtures carry the fields of the SDK messages ClaudeState reads; tests omit unrelated ones.
const sdk = (message: JsonObject): SDKMessage => JSON.parse(JSON.stringify(message));
const state = (rows: string) => { const value = new ClaudeState(); value.hydrate(claudeRows(rows)); return value; };

test("groups a prompt's thinking, tool calls and steering into one turn with its final answer", () => {
  const items = projectClaudeTranscript(state(jsonl(
    { type: "queue-operation", operation: "enqueue" },
    user("prompt", 0, [{ type: "text", text: "Run date" }]),
    { type: "attachment", uuid: "meta", timestamp: time(0), attachment: { type: "total_tokens_reminder" } },
    assistant("a1", 1, "msg_1", [{ type: "thinking", thinking: "Checking the clock." }]),
    assistant("a2", 1, "msg_1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "date" } }], "tool_use"),
    user("result", 3, [{ type: "tool_result", tool_use_id: "toolu_1", content: "Mon Oct 12", is_error: false }]),
    { type: "attachment", uuid: "steer-row", timestamp: time(3), attachment: { type: "queued_command", prompt: [{ type: "text", text: "Also be brief." }], source_uuid: "steer" } },
    assistant("a3", 4, "msg_2", [{ type: "text", text: "It is Monday." }], "end_turn"),
  )), false);
  expect(items.map(item => item.type)).toEqual(["user", "working", "text"]);
  const [prompt, working, final] = items;
  expect(prompt).toMatchObject({ key: "prompt", text: "Run date" });
  expect(final).toMatchObject({ key: "msg_2:0", text: "It is Monday.", final: true });
  if (working?.type !== "working") throw new Error("Expected a working section");
  expect(working).toMatchObject({ startedAt: Date.parse(time(0)), completedAt: Date.parse(time(4)), hasFinalAnswer: true, live: false });
  expect(working.items.map(item => [item.type, item.key])).toEqual([["thinking", "msg_1:0"], ["tool", "tool:toolu_1"], ["user", "steer"]]);
  expect(working.items[1]).toMatchObject({ tool: { name: "bash", args: { command: "date" }, status: "ok", resultText: "Mon Oct 12", durationMs: 2000 } });
  expect(working.items[2]).toMatchObject({ text: "Also be brief.", steering: true });
});

test("shows interruptions as stopped turns, and slash commands as the prompts they were", () => {
  const items = projectClaudeTranscript(state(jsonl(
    user("first", 0, [{ type: "text", text: "Write an essay" }]),
    user("interrupt", 2, [{ type: "text", text: "[Request interrupted by user]" }]),
    user("model-caveat", 3, "<local-command-caveat>Caveat</local-command-caveat>", { isMeta: true }),
    user("model", 3, "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>haiku</command-args>"),
    user("model-output", 3, "<local-command-stdout>Set model to haiku</local-command-stdout>"),
    { type: "system", subtype: "compact_boundary", uuid: "boundary", timestamp: time(9) },
    user("summary", 9, "This session is being continued…", { isCompactSummary: true }),
    user("compact", 5, "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"),
    user("compact-output", 9, "<local-command-stdout>Compacted </local-command-stdout>"),
  )), false);
  expect(items.map(item => [item.type, "text" in item ? item.text : undefined])).toEqual([["user", "Write an essay"], ["working", undefined], ["user", "/compact"], ["working", undefined]]);
  expect(items[1]).toMatchObject({ stoppedAt: Date.parse(time(2)), items: [] });
  expect(items[3]).toMatchObject({ completedAt: Date.parse(time(9)), items: [{ type: "note", text: "Claude compacted the conversation." }, { type: "note", text: "Compacted" }] });
});

test("streams blocks under the keys their committed messages keep", () => {
  const value = state(jsonl(user("prompt", 0, [{ type: "text", text: "Hi" }])));
  const event = (event: JsonObject) => value.receive(sdk({ type: "stream_event", event, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "s" }));
  event({ type: "message_start", message: { id: "msg_1" } });
  event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm" } });
  event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } });
  event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } });
  const live = projectClaudeTranscript(value, true);
  expect(live).toMatchObject([{ type: "user" }, { type: "working", live: true, items: [{ type: "thinking", key: "msg_1:0", text: "Hmm", live: true }, { type: "text", key: "msg_1:1", text: "Hello", live: true }] }]);
  value.receive(sdk({ type: "assistant", uuid: "a1", session_id: "s", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "thinking", thinking: "Hmm" }], stop_reason: null } }));
  expect(projectClaudeTranscript(value, true)[1]).toMatchObject({ items: [{ key: "msg_1:0", live: false }, { key: "msg_1:1", text: "Hello", live: true }] });
  value.receive(sdk({ type: "assistant", uuid: "a2", session_id: "s", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn" } }));
  event({ type: "message_stop" });
  expect(projectClaudeTranscript(value, false).slice(1)).toMatchObject([{ type: "working", hasFinalAnswer: true, items: [{ key: "msg_1:0" }] }, { type: "text", key: "msg_1:1", final: true, live: false }]);
});

test("ignores the conversations of Claude's own subagents", () => {
  const value = state(jsonl(user("prompt", 0, [{ type: "text", text: "Delegate" }]), { ...assistant("side", 1, "msg_side", [{ type: "text", text: "Subagent work" }]), isSidechain: true }));
  value.receive(sdk({ type: "assistant", uuid: "nested", session_id: "s", parent_tool_use_id: "toolu_task", message: { id: "msg_nested", content: [{ type: "text", text: "Nested" }], stop_reason: null } }));
  expect(JSON.stringify(projectClaudeTranscript(value, false))).not.toMatch(/Subagent work|Nested/);
});

test("history replaces streamed rows, keeps unrecorded prompts and drops prompts Claude echoed as commands", () => {
  const value = new ClaudeState();
  value.add({ kind: "user", uuid: "sent", timestamp: Date.parse(time(0)), content: [{ type: "text", text: "Hello" }], meta: false });
  value.add({ kind: "user", uuid: "local-compact", timestamp: Date.parse(time(5)), content: [{ type: "text", text: "/compact" }], meta: false });
  value.add({ kind: "steer", uuid: "queued", timestamp: Date.parse(time(6)), text: "Still waiting" });
  value.merge(claudeRows(jsonl(user("sent", 0, [{ type: "text", text: "Hello" }]), user("echo", 5, "<command-name>/compact</command-name><command-args></command-args>"))));
  expect(value.rows.map(row => row.uuid)).toEqual(["sent", "echo", "queued"]);
});

const notification = (taskId: string, summary: string) => `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;

test("Claude's report on finished background work is a turn of its own, after the answer that started it", () => {
  const started = jsonl(
    user("prompt", 0, [{ type: "text", text: "Run the suite in the background" }]),
    assistant("a1", 1, "msg_1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "bun test", run_in_background: true } }]),
    user("result", 1, [{ type: "tool_result", tool_use_id: "toolu_1", content: "Running in background", is_error: false }]),
    assistant("a2", 2, "msg_2", [{ type: "text", text: "Started the suite." }]),
  );
  const value = state(started);
  // Claude starts reporting before history records the notification.
  value.add({ kind: "task", uuid: "announced", timestamp: Date.parse(time(8)), runId: "run-1", summary: "Background command \"bun test\" completed" });
  const live = projectClaudeTranscript(value, true);
  expect(live.map(item => [item.type, "text" in item ? item.text : undefined, item.type === "working" ? item.live : undefined])).toEqual([
    ["user", "Run the suite in the background", undefined], ["working", undefined, false], ["text", "Started the suite.", undefined],
    ["note", "Background command \"bun test\" completed", undefined], ["working", undefined, true],
  ]);
  const reported = started + "\n" + jsonl(
    user("recorded", 8, notification("suite", "Background command \"bun test\" completed"), { origin: { kind: "task-notification", runId: "run-1" } }),
    assistant("a3", 9, "msg_3", [{ type: "text", text: "All tests pass." }]),
  );
  value.merge(claudeRows(reported));
  expect(projectClaudeTranscript(value, false).map(item => [item.type, "text" in item ? item.text : undefined])).toEqual([
    ["user", "Run the suite in the background"], ["working", undefined], ["text", "Started the suite."],
    ["note", "Background command \"bun test\" completed"], ["working", undefined], ["text", "All tests pass."],
  ]);
  // A resumed task finishes again under the same task ID, in a run of its own.
  value.add({ kind: "task", uuid: "announced-again", timestamp: Date.parse(time(20)), runId: "run-2", summary: "Background command \"bun test\" completed" });
  value.merge(claudeRows(reported));
  expect(value.rows.at(-1)).toMatchObject({ uuid: "announced-again" });
});

test("background work that finishes mid-turn is absorbed into it", () => {
  const items = projectClaudeTranscript(state(jsonl(
    user("prompt", 0, [{ type: "text", text: "Build, then test" }]),
    assistant("a1", 1, "msg_1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "bun run build" } }]),
    user("result", 4, [{ type: "tool_result", tool_use_id: "toolu_1", content: "Built", is_error: false }]),
    user("task", 5, notification("watcher", "Background command \"sleep 3\" completed")),
    assistant("a2", 6, "msg_2", [{ type: "text", text: "Built and slept." }]),
  )), false);
  expect(items.map(item => item.type)).toEqual(["user", "working", "text"]);
  expect(items[1]).toMatchObject({ items: [{ type: "tool" }, { type: "note", text: "Background command \"sleep 3\" completed" }] });
});

test("prompts may start with any tag; only Claude's own tagged messages stay hidden", () => {
  const items = projectClaudeTranscript(state(jsonl(
    user("pasted", 0, [{ type: "text", text: "<pasted_content>\nlog\n</pasted_content>\nWhy?" }]),
    user("reminder", 1, "<system-reminder>Internal</system-reminder>"),
    assistant("a1", 2, "msg_1", [{ type: "text", text: "Because." }], "end_turn"),
    user("html", 3, [{ type: "text", text: "<div>Fix this</div> <command-name>/compact</command-name>" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]),
    assistant("a2", 4, "msg_2", [{ type: "text", text: "Fixed." }], "end_turn"),
  )), false);
  expect(items.map(item => [item.type, "text" in item ? item.text : undefined])).toEqual([
    ["user", "<pasted_content>\nlog\n</pasted_content>\nWhy?"], ["working", undefined], ["text", "Because."],
    ["user", "<div>Fix this</div> <command-name>/compact</command-name>"], ["working", undefined], ["text", "Fixed."],
  ]);
  expect(items[3]).toMatchObject({ images: [{ entryId: "html", contentIndex: 0 }] });
});

test("a turn that ends in an error shows as stopped, with the error after it", () => {
  const items = projectClaudeTranscript(state(jsonl(
    user("prompt", 0, [{ type: "text", text: "Run date" }]),
    assistant("a1", 1, "msg_1", [{ type: "text", text: "Checking." }]),
    { ...assistant("failed", 9, "msg_2", [{ type: "text", text: "API Error: 502 OAuth refresh failed" }], "stop_sequence"), isApiErrorMessage: true },
  )), false);
  expect(items.map(item => item.type)).toEqual(["user", "working", "error"]);
  expect(items[1]).toMatchObject({ stoppedAt: Date.parse(time(9)), hasFinalAnswer: false, items: [{ type: "text", text: "Checking." }] });
  expect(items[1]).not.toHaveProperty("completedAt");
  expect(items[2]).toMatchObject({ key: "failed:error", text: "API Error: 502 OAuth refresh failed" });
});

test("references prompt images by their row and position", () => {
  const items = projectClaudeTranscript(state(jsonl(user("with-image", 0, [{ type: "text", text: "Look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]))), false);
  expect(items[0]).toMatchObject({ type: "user", images: [{ entryId: "with-image", contentIndex: 0, mimeType: "image/png" }] });
});
