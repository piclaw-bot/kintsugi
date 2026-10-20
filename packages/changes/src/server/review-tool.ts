import { Type } from "typebox";
import { defineWorkspaceTool } from "@kintsugi/agent/server/workspace-tool";
import type { ReviewComment } from "../comments.ts";
import { ReviewDeliveryError, type createReviewDeliveryStore } from "./review-delivery.ts";

export function createCodeReviewTool(workspaceId: string, deliveries: ReturnType<typeof createReviewDeliveryStore>, comments: () => readonly ReviewComment[]) {
  return defineWorkspaceTool({
    name: "code_review", label: "Code Review", requiresAgentIdentity: true,
    description: "Read review-comment batches explicitly sent to you by the user. action=list returns recent batch IDs; action=read requires batchId. Posting or copying comments alone does not grant access. This tool does not change source, resolve comments or start work. Deleted or superseded comments revoke the captured batch; ask the user to send the latest version.",
    parameters: Type.Object({ action: Type.String({ enum: ["list", "read"] }), batchId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) }, { additionalProperties: false }),
    async execute(_id, input, _signal, _update, identity) {
      if (!identity) throw new ReviewDeliveryError("Verified calling Agent identity is required.", 403);
      if (input.action === "read") {
        if (!input.batchId) throw new ReviewDeliveryError("Choose a review batch ID.", 400);
        const batch = deliveries.readForAgent(workspaceId, identity.agentId, input.batchId, comments());
        return { content: [{ type: "text" as const, text: batch.prompt }], details: { batchId: batch.id, status: batch.status } };
      }
      const live = comments();
      const result = deliveries.list(workspaceId, identity.agentId).filter(batch => ["sending", "queued", "uncertain"].includes(batch.status) && batch.versions.every(version => live.some(comment => comment.id === version.id && comment.revision === version.revision))).slice(-20).reverse().map(batch => ({ batchId: batch.id, createdAt: batch.createdAt, status: batch.status, comments: batch.versions.length }));
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { batches: result.length } };
    },
  });
}
