import { expect, test } from "bun:test";
import { claudeRows } from "../src/server/rows.ts";
import { ClaudeState } from "../src/server/state.ts";
import { projectClaudeTranscript } from "../src/server/transcript.ts";

const timestamp = "2026-10-20T12:00:00Z";
const text = "<task-notification><summary>Suite passed</summary></task-notification>";

test("queued task delivery needs native run provenance; a user can steer with literal notification XML", () => {
  const row = { type: "attachment", uuid: "delivery", timestamp, attachment: { type: "queued_command", prompt: text, source_uuid: "steering" } };
  expect(claudeRows(JSON.stringify(row))).toMatchObject([{ kind: "steer", uuid: "steering", content: [{ type: "text", text }] }]);
  expect(claudeRows(JSON.stringify({ ...row, attachment: { ...row.attachment, runId: "run-1" } }))).toMatchObject([{ kind: "task", runId: "run-1", summary: "Suite passed" }]);
});

test("steering retains image blocks and their session references", () => {
  const content = [{ type: "text", text: "Review this image" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture-image" } }];
  const state = new ClaudeState();
  state.hydrate(claudeRows(JSON.stringify({ type: "attachment", uuid: "image-delivery", timestamp, attachment: { type: "queued_command", prompt: content, source_uuid: "steering" } })));
  expect(state.rows[0]).toMatchObject({ kind: "steer", content });
  expect(projectClaudeTranscript(state, true)).toMatchObject([{ type: "user", text: "Review this image", steering: true, images: [{ entryId: "steering", contentIndex: 0, mimeType: "image/png" }] }]);
});

test("canonical local command output replaces its streamed synthetic reply and cannot answer the next turn", () => {
  const command = { type: "user", uuid: "command", timestamp, message: { content: "/code-review" } };
  const output = { type: "system", subtype: "local_command", uuid: "output", timestamp, content: "<local-command-stdout>Review complete</local-command-stdout>" };
  const state = new ClaudeState();
  state.hydrate(claudeRows(JSON.stringify(command)));
  // SAFETY: This fixture supplies the synthetic envelope fields consumed by receive; no transport or inference runs.
  state.receive({ type: "assistant", uuid: "output", parent_tool_use_id: null, session_id: "fixture", message: { id: "synthetic", model: "<synthetic>", content: [{ type: "text", text: "Review complete" }] } } as unknown as Parameters<ClaudeState["receive"]>[0]);
  expect(state.rows.at(-1)).toMatchObject({ kind: "output", uuid: "output", text: "Review complete" });
  state.merge(claudeRows([command, output, { type: "user", uuid: "next", timestamp, message: { content: "Next task" } }].map(row => JSON.stringify(row)).join("\n")));
  expect(state.rows.filter(row => row.uuid === "output")).toHaveLength(1);
  const items = projectClaudeTranscript(state, false);
  expect(items.filter(item => item.type === "text")).toMatchObject([{ text: "Review complete", final: true }]);
  expect(items.at(-1)).toMatchObject({ type: "working", items: [], hasFinalAnswer: false });
});
