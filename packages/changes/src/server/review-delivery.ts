import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { createWorkspaceMetadataState } from "@kintsugi/workspace";
import { exportReviewComments, reviewCommentSchema, type CommentPlacement, type ReviewComment } from "../comments.ts";

const versionSchema = Type.Object({ id: Type.String(), revision: Type.Integer({ minimum: 1 }) });
const batchSchema = Type.Object({
  id: Type.String(), agentId: Type.String(), agentTitle: Type.String(), createdAt: Type.String(),
  status: Type.Union([Type.Literal("prepared"), Type.Literal("sending"), Type.Literal("queued"), Type.Literal("uncertain"), Type.Literal("failed")]),
  comments: Type.Array(reviewCommentSchema, { maxItems: 50 }), versions: Type.Array(versionSchema, { maxItems: 50 }), prompt: Type.String({ maxLength: 50000 }),
});
export type ReviewDelivery = Static<typeof batchSchema>;
const stateSchema = Type.Object({ batches: Type.Array(batchSchema, { maxItems: 256 }) });
export class ReviewDeliveryError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

/** Immutable operator-approved batches. Copying or editing comments never grants agent access. */
export function createReviewDeliveryStore(options: { dataDir?: string } = {}) {
  const state = createWorkspaceMetadataState("review-deliveries.json", value => Value.Parse(stateSchema, value), () => ({ batches: [] }), options);
  function validateWorkspace(workspaceId: string) { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(workspaceId)) throw new ReviewDeliveryError("Invalid workspace identifier.", 400); }
  function batches(workspaceId: string) { validateWorkspace(workspaceId); return state.read(workspaceId).batches; }
  function find(workspaceId: string, id: string) {
    const batch = batches(workspaceId).find(batch => batch.id === id);
    if (!batch) throw new ReviewDeliveryError("Review delivery not found.", 404);
    return batch;
  }
  function current(batch: ReviewDelivery, comments: readonly ReviewComment[]) {
    return batch.versions.every(version => comments.some(comment => comment.id === version.id && comment.revision === version.revision));
  }
  function replace(workspaceId: string, batch: ReviewDelivery) {
    const next = { batches: batches(workspaceId).map(previous => previous.id === batch.id ? batch : previous) };
    state.write(workspaceId, next);
    return structuredClone(batch);
  }
  return {
    get(workspaceId: string, id: string) { return structuredClone(find(workspaceId, id)); },
    recent(workspaceId: string) {
      const all = batches(workspaceId), active = all.filter(batch => batch.status === "sending" || batch.status === "uncertain");
      const settled = all.filter(batch => batch.status === "queued" || batch.status === "failed").slice(-5);
      return [...active, ...settled.reverse()].map(({ id, agentTitle, status, versions }) => ({ id, agentTitle, status, comments: versions.length }));
    },
    list(workspaceId: string, agentId: string) { return structuredClone(batches(workspaceId).filter(batch => batch.agentId === agentId)); },
    prepare(workspaceId: string, agent: { id: string; title: string }, comments: readonly CommentPlacement[]) {
      const previous = batches(workspaceId);
      const pending = previous.find(batch => batch.agentId === agent.id && (batch.status === "sending" || batch.status === "uncertain"));
      if (pending) throw new ReviewDeliveryError("Check the earlier delivery before sending more comments to this Agent.");
      const unsent = comments.filter(comment => !previous.some(batch => batch.agentId === agent.id && batch.status === "queued" && batch.versions.some(version => version.id === comment.id && version.revision === comment.revision)));
      if (!unsent.length) throw new ReviewDeliveryError("No new or updated comments to send.", 422);
      const selected = unsent.slice(0, 50);
      const prefix = "Please address these saved review comments. Check their code context before making changes. Comments labelled as moved or from another comparison may refer to older source. Read this batch with code_review if needed.\n\n";
      const warnings = selected.filter(comment => comment.status !== "inline").map(comment => `${comment.path}: ${comment.status === "other" ? "another comparison" : "code has changed"}`).join("\n");
      const id = randomUUID();
      const prompt = `${prefix}Review batch: ${id}\n${warnings ? `\nSource warnings:\n${warnings}\n` : ""}\n${exportReviewComments(selected)}`;
      if (prompt.length > 50000) throw new ReviewDeliveryError("These comments are too large for one send. Shorten them or send fewer comments.", 413);
      // A user-deleted comment revokes the whole captured batch. Keep unresolved deliveries
      // until reconciled, but discard obsolete previews and revoked completed snapshots.
      const retained = previous.filter(batch => batch.status === "prepared" ? batch.agentId !== agent.id && current(batch, comments) : batch.status === "sending" || batch.status === "uncertain" || current(batch, comments));
      if (retained.length >= 256) throw new ReviewDeliveryError("Review delivery history is full. Remove old review comments before sending more.", 413);
      const batch: ReviewDelivery = { id, agentId: agent.id, agentTitle: agent.title, createdAt: new Date().toISOString(), status: "prepared", comments: selected.map(({ status: _status, placedStart: _start, placedEnd: _end, ...comment }) => comment), versions: selected.map(({ id, revision }) => ({ id, revision })), prompt };
      state.write(workspaceId, { batches: [...retained, batch] });
      return structuredClone(batch);
    },
    begin(workspaceId: string, id: string, comments: readonly ReviewComment[]) {
      const batch = find(workspaceId, id);
      if (batch.status !== "prepared") throw new ReviewDeliveryError("This send has already started. Check the Agent before trying again.");
      if (!current(batch, comments)) throw new ReviewDeliveryError("The comments changed. Preview the latest comments before sending.");
      if (batches(workspaceId).some(other => other.id !== id && other.agentId === batch.agentId && (other.status === "sending" || other.status === "uncertain"))) throw new ReviewDeliveryError("An earlier delivery needs checking first.");
      return replace(workspaceId, { ...batch, status: "sending" });
    },
    complete(workspaceId: string, id: string, status: "queued" | "uncertain") {
      const batch = find(workspaceId, id);
      if (batch.status === "queued") return structuredClone(batch);
      if (batch.status !== "sending" && batch.status !== "uncertain") throw new ReviewDeliveryError("This delivery has not started.");
      return replace(workspaceId, { ...batch, status });
    },
    confirmNotDelivered(workspaceId: string, id: string) {
      const batch = find(workspaceId, id);
      if (batch.status !== "uncertain" && batch.status !== "sending") throw new ReviewDeliveryError("This delivery does not need checking.");
      return replace(workspaceId, { ...batch, status: "failed" });
    },
    readForAgent(workspaceId: string, agentId: string, id: string, comments: readonly ReviewComment[]) {
      const batch = find(workspaceId, id);
      if (batch.agentId !== agentId || !["sending", "queued", "uncertain"].includes(batch.status)) throw new ReviewDeliveryError("This review batch was not sent to you.", 403);
      if (!current(batch, comments)) throw new ReviewDeliveryError("This review batch changed or was deleted. Ask for the latest comments.");
      return structuredClone(batch);
    },
    delete(workspaceId: string) { validateWorkspace(workspaceId); state.delete(workspaceId); }
  };
}
export const reviewDeliveries = createReviewDeliveryStore();
