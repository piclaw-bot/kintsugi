import { expect, test } from "bun:test";
import { claudeRows } from "../src/server/rows.ts";

const text = "<task-notification>\n<summary>Suite passed</summary>\n</task-notification>";
const user = { type: "user", uuid: "notification", timestamp: "2026-10-19T10:00:00Z", message: { content: [{ type: "text", text }] } };

test("native task origin identifies background completion independently of user-pasted XML", () => {
  expect(claudeRows(JSON.stringify({ ...user, origin: { kind: "task-notification", runId: "run-1" } }))).toMatchObject([{ kind: "task", runId: "run-1", summary: "Suite passed" }]);
  expect(claudeRows(JSON.stringify(user))).toMatchObject([{ kind: "user", meta: false }]);
  expect(claudeRows(JSON.stringify({ ...user, origin: { kind: "different-origin", runId: "run-1" } }))).toMatchObject([{ kind: "user", meta: false }]);
});

test("older native metadata can identify a task without granting plain text task provenance", () => {
  expect(claudeRows(JSON.stringify({ ...user, isMeta: true }))).toMatchObject([{ kind: "task", runId: user.uuid }]);
  expect(claudeRows(JSON.stringify({ ...user, isMeta: true, message: { content: "Ordinary metadata" } }))).toMatchObject([{ kind: "user", meta: true }]);
});
