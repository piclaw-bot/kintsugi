import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewDeliveryStore } from "../src/server/review-delivery.ts";
import type { CommentPlacement } from "../src/comments.ts";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "review-delivery-")); directories.push(dataDir);
  const store = createReviewDeliveryStore({ dataDir });
  const comment: CommentPlacement = { id: "comment", revision: 1, copiedRevision: 0, body: "Handle this error", path: "example.ts", side: "additions", start: 1, end: 1, comparison: { key: "uncommitted", label: "Uncommitted", baseLabel: "HEAD", targetLabel: "Working tree", base: "head", target: "working" }, anchor: { code: ["fetch(url)"], before: [], after: [] }, status: "inline" };
  return { dataDir, store, comment, agent: { id: "agent-a", title: "Owner" } };
}
test("previews persist without granting agent access or starting delivery", () => {
  const { dataDir, store, comment, agent } = fixture();
  const batch = store.prepare("workspace", agent, [comment]);
  expect(batch.status).toBe("prepared");
  expect(() => store.readForAgent("workspace", agent.id, batch.id, [comment])).toThrow("not sent");
  expect(createReviewDeliveryStore({ dataDir }).get("workspace", batch.id)).toEqual(batch);
  expect(store.list("another", agent.id)).toEqual([]);
  batch.comments[0]!.body = "mutated";
  expect(store.get("workspace", batch.id).comments[0]!.body).toBe(comment.body);
});
test("only an explicit begin grants the exact Agent the captured batch", () => {
  const { store, comment, agent } = fixture(), batch = store.prepare("workspace", agent, [comment]);
  expect(store.begin("workspace", batch.id, [comment]).status).toBe("sending");
  expect(store.readForAgent("workspace", agent.id, batch.id, [comment]).comments).toEqual([((({ status: _status, ...saved }) => saved)(comment))]);
  expect(() => store.readForAgent("workspace", "agent-b", batch.id, [comment])).toThrow("not sent");
  expect(() => store.begin("workspace", batch.id, [comment])).toThrow("already started");
  expect(() => store.prepare("workspace", agent, [comment])).toThrow("earlier delivery");
});
test("stale previews cannot send and deleted or edited comments revoke reads", () => {
  const { store, comment, agent } = fixture(), batch = store.prepare("workspace", agent, [comment]);
  const edited = { ...comment, revision: 2, body: "Updated" };
  expect(() => store.begin("workspace", batch.id, [edited])).toThrow("comments changed");
  store.begin("workspace", batch.id, [comment]);
  expect(() => store.readForAgent("workspace", agent.id, batch.id, [])).toThrow("deleted");
  expect(() => store.readForAgent("workspace", agent.id, batch.id, [edited])).toThrow("changed");
});
test("queued revisions are not resent, while changed comments and other targets are separate", () => {
  const { store, comment, agent } = fixture(), batch = store.prepare("workspace", agent, [comment]);
  store.begin("workspace", batch.id, [comment]); store.complete("workspace", batch.id, "queued");
  expect(() => store.prepare("workspace", agent, [comment])).toThrow("No new");
  expect(store.prepare("workspace", { id: "agent-b", title: "Reviewer" }, [comment]).agentId).toBe("agent-b");
  expect(store.prepare("workspace", agent, [{ ...comment, revision: 2 }]).versions).toEqual([{ id: comment.id, revision: 2 }]);
});
test("uncertain deliveries are never replayed and acknowledgement cannot downgrade queued", () => {
  const { store, comment, agent } = fixture(), batch = store.prepare("workspace", agent, [comment]);
  store.begin("workspace", batch.id, [comment]); store.complete("workspace", batch.id, "uncertain");
  expect(() => store.prepare("workspace", agent, [comment])).toThrow("Check");
  store.complete("workspace", batch.id, "queued");
  expect(store.complete("workspace", batch.id, "uncertain").status).toBe("queued");
  expect(() => store.confirmNotDelivered("workspace", batch.id)).toThrow("does not need");
});
test("an operator can explicitly reconcile a missing send; bodies are bounded and warnings retained", () => {
  const { store, comment, agent } = fixture(), batch = store.prepare("workspace", agent, [{ ...comment, status: "changed" }]);
  expect(batch.prompt).toContain("code has changed");
  store.begin("workspace", batch.id, [comment]); store.confirmNotDelivered("workspace", batch.id);
  expect(store.prepare("workspace", agent, [comment]).id).not.toBe(batch.id);
  expect(() => store.prepare("workspace", agent, Array.from({ length: 50 }, (_, i) => ({ ...comment, id: String(i), body: "x".repeat(2000) })))).toThrow("too large");
});

test("concurrent Agent previews stay separate and pending receipts remain discoverable", () => {
  const { store, comment, agent } = fixture();
  const first = store.prepare("workspace", agent, [comment]);
  const other = store.prepare("workspace", { id: "agent-b", title: "B" }, [comment]);
  expect(store.get("workspace", first.id).agentId).toBe(agent.id);
  store.begin("workspace", first.id, [comment]); store.complete("workspace", first.id, "uncertain");
  store.begin("workspace", other.id, [comment]); store.complete("workspace", other.id, "queued");
  expect(store.recent("workspace").some(batch => batch.id === first.id)).toBe(true);
  expect(() => store.get("../escape", first.id)).toThrow("Invalid workspace");
  expect(() => store.delete("../escape")).toThrow("Invalid workspace");
});

test("code_review requires host identity and explicit dispatch; edits and deletes revoke it", async () => {
  const { createCodeReviewTool } = await import("../src/server/review-tool.ts");
  const { Value } = await import("typebox/value");
  const { store, comment, agent } = fixture(); let live = [comment];
  const tool = createCodeReviewTool("workspace", store, () => live);
  expect(Value.Check(tool.parameters, { action: "list", agentId: agent.id })).toBe(false);
  await expect(tool.execute("call", { action: "list" })).rejects.toThrow("identity is required");
  const batch = store.prepare("workspace", agent, live);
  await expect(tool.execute("call", { action: "read", batchId: batch.id }, undefined, undefined, { agentId: agent.id })).rejects.toThrow("not sent");
  store.begin("workspace", batch.id, live); store.complete("workspace", batch.id, "queued");
  const result = await tool.execute("call", { action: "read", batchId: batch.id }, undefined, undefined, { agentId: agent.id });
  expect(result.content).toEqual([{ type: "text", text: batch.prompt }]);
  await expect(tool.execute("call", { action: "read", batchId: batch.id }, undefined, undefined, { agentId: "other" })).rejects.toThrow("not sent");
  expect((await tool.execute("call", { action: "list" }, undefined, undefined, { agentId: "other" })).content).toEqual([{ type: "text", text: "[]" }]);
  live = [];
  await expect(tool.execute("call", { action: "read", batchId: batch.id }, undefined, undefined, { agentId: agent.id })).rejects.toThrow("deleted");
  expect((await tool.execute("call", { action: "list" }, undefined, undefined, { agentId: agent.id })).content).toEqual([{ type: "text", text: "[]" }]);
});
