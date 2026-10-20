import { Type } from "typebox";
import { Value } from "typebox/value";
import { KintsugiCoreError, readJsonObject } from "@kintsugi/core";
import { requirePlanAgent } from "@kintsugi/agent/server/plan";
import { agentRequestWasAccepted } from "@kintsugi/agent/server/request-receipts";
import { buttonHtml } from "@kintsugi/design-system/button";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { Icons } from "@kintsugi/design-system/icons";
import { domId, escapeHtml as h } from "@kintsugi/shared";
import { stream, update, textResponse } from "@kintsugi/shared/http";
import { placeReviewComments, reviewComments } from "./comments.ts";
import { ReviewDeliveryError, reviewDeliveries, type ReviewDelivery } from "./review-delivery.ts";
import type { ChangesSnapshot } from "./snapshot.ts";
const previewId = (key: string) => domId("review_send_preview", key);
const feedbackId = (key: string) => domId("review_send_feedback", key);
const responseId = (key: string) => domId("review_send_response", key);
const reply = (key: string, operationId: string, ...html: string[]) => stream(html.join("") + update(responseId(key), h(operationId)));
const json = <Value>(value: Value) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
const button = (caption: string, action: string, attrs = "", primary = false) => buttonHtml({ type: "button", variant: primary ? "primary" : "secondary", content: { kind: "caption", caption }, attributesHtml: `data-action="review-send#${action}" ${attrs}` });
function feedback(workspaceId: string, message = ""): string {
  return `${message ? `<p>${h(message)}</p>` : ""}${reviewDeliveries.recent(workspaceId).map(batch => {
    const label = batch.status === "queued" ? "Queued" : batch.status === "failed" ? "Not delivered" : "Delivery uncertain";
    const check = batch.status === "sending" || batch.status === "uncertain" ? button("Check delivery", "check", `data-batch-id="${h(batch.id)}"`) : "";
    return `<div class="changes-review-delivery-status"><span>${h(label)} · ${h(batch.agentTitle)} · ${batch.comments} ${batch.comments === 1 ? "comment" : "comments"}</span>${check}</div>`;
  }).join("")}`;
}
export function renderReviewSend(workspaceId: string, key: string, hasComments = true): string {
  if (!hasComments && !reviewDeliveries.recent(workspaceId).some(batch => batch.status === "sending" || batch.status === "uncertain")) return "";
  return `<section class="changes-review-send" data-controller="review-send" data-review-send-workspace-id-value="${h(workspaceId)}" data-review-send-key-value="${h(key)}">${button("Send to Agent…", "preview", 'data-review-send-target="button"')}<div id="${feedbackId(key)}" data-review-send-target="feedback" role="status">${feedback(workspaceId)}</div><p hidden data-review-send-target="error" role="alert"></p><span hidden id="${responseId(key)}" data-review-send-target="response"></span><div id="${previewId(key)}" data-review-send-target="preview"></div></section>`;
}
function preview(batch: ReviewDelivery): string {
  return dialogHtml({ element: { attributesHtml: `data-review-send-target="dialog" data-batch-id="${h(batch.id)}" data-agent-id="${h(batch.agentId)}"` }, iconHtml: Icons.Changes, titleCaption: `Send ${batch.comments.length} ${batch.comments.length === 1 ? "comment" : "comments"} to ${batch.agentTitle}?`, bodyHtml: `<p>This starts Agent work. Only saved, new or updated comments for this Agent are included (up to 50 per send). Your composer draft stays unchanged.</p><textarea class="textarea changes-review-send-preview" aria-label="Review comment preview" readonly>${h(batch.prompt)}</textarea>`, footerHtml: `${button("Cancel", "cancel")}${button("Send comments", "confirm", "", true)}` });
}
function reconciliation(batch: ReviewDelivery, supported: boolean): string {
  return dialogHtml({ element: { attributesHtml: `data-review-send-target="dialog" data-batch-id="${h(batch.id)}"` }, iconHtml: Icons.Changes, titleCaption: "Check this Agent before sending again", bodyHtml: `<p>${supported ? "No committed receipt was found." : "This Agent has no automatic receipt check."} Check ${h(batch.agentTitle)}’s transcript or terminal. Retrying an accepted request could start duplicate work.</p><label><input type="checkbox" required data-review-send-target="notDelivered"> I checked this Agent; these comments were not delivered.</label>`, footerHtml: `${button("Cancel", "cancel")}${button("Mark not delivered", "markNotDelivered")}` });
}
const inputSchema = Type.Object({ operationId: Type.String({ minLength: 1, maxLength: 64 }), key: Type.String({ minLength: 1, maxLength: 200 }), agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), status: Type.Optional(Type.String({ enum: ["queued", "uncertain"] })), confirmAbsent: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export async function handleReviewDelivery(request: Request, url: URL, snapshot: (workspaceId: string) => Promise<ChangesSnapshot>): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/changes\/review-delivery\/(prepare|begin|ack|check|not-delivered)$/);
  if (!match) return;
  if (request.method !== "POST") return textResponse("Method not allowed", { status: 405 });
  const workspaceId = decodeURIComponent(match[1]!), operation = match[2]!;
  try {
    const input = await readJsonObject(request);
    if (!Value.Check(inputSchema, input)) throw new ReviewDeliveryError("Invalid review delivery request.", 400);
    if (operation === "prepare") {
      if (!input.agentId) throw new ReviewDeliveryError("Select an Agent before sending comments.", 400);
      const agent = await requirePlanAgent(workspaceId, input.agentId);
      if (agent.readOnly) throw new ReviewDeliveryError("This Agent is read-only.", 403);
      const batch = reviewDeliveries.prepare(workspaceId, agent, placeReviewComments(reviewComments.list(workspaceId), await snapshot(workspaceId)));
      return reply(input.key, input.operationId, update(previewId(input.key), preview(batch)));
    }
    if (!input.id) throw new ReviewDeliveryError("Choose a review delivery.", 400);
    const saved = reviewDeliveries.get(workspaceId, input.id);
    const agent = await requirePlanAgent(workspaceId, saved.agentId);
    if (agent.readOnly) throw new ReviewDeliveryError("This Agent is read-only.", 403);
    if (operation === "begin") {
      const batch = reviewDeliveries.begin(workspaceId, input.id, reviewComments.list(workspaceId));
      return reply(input.key, input.operationId, update(previewId(input.key), `<script type="application/json" data-review-send-target="outbox">${json({ id: batch.id, agentId: batch.agentId, text: batch.prompt })}</script>`) + update(feedbackId(input.key), feedback(workspaceId)));
    }
    if (operation === "ack") {
      if (input.status !== "queued" && input.status !== "uncertain") throw new ReviewDeliveryError("Invalid delivery result.", 400);
      reviewDeliveries.complete(workspaceId, input.id, input.status);
    } else if (operation === "check") {
      const accepted = await agentRequestWasAccepted(workspaceId, saved.agentId, saved.id);
      if (accepted) reviewDeliveries.complete(workspaceId, input.id, "queued");
      else return reply(input.key, input.operationId, update(previewId(input.key), reconciliation(saved, accepted !== undefined)) + update(feedbackId(input.key), feedback(workspaceId)));
    } else {
      if (input.confirmAbsent !== true) throw new ReviewDeliveryError("Check the Agent and confirm that these comments were not delivered.", 400);
      reviewDeliveries.confirmNotDelivered(workspaceId, input.id);
    }
    return reply(input.key, input.operationId, update(feedbackId(input.key), feedback(workspaceId)) + update(previewId(input.key), ""));
  } catch (error) {
    if (!(error instanceof ReviewDeliveryError) && !(error instanceof KintsugiCoreError)) throw error;
    return textResponse(error.message, { status: error instanceof ReviewDeliveryError ? error.status : 400 });
  }
}

export const reviewDeliveryOpenApiPaths = Object.fromEntries(["prepare", "begin", "ack", "check", "not-delivered"].map(operation => [`/workspaces/{id}/changes/review-delivery/${operation}`, {
  post: {
    summary: `${operation === "prepare" ? "Preview saved comments for a selected Agent" : operation === "begin" ? "Confirm an immutable review batch before composer delivery" : operation === "ack" ? "Record queued or uncertain composer delivery" : operation === "check" ? "Check an Agent receipt without resending" : "Explicitly reconcile a user-verified missing delivery"}`,
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    requestBody: { required: true, content: { "application/json": { schema: JSON.parse(JSON.stringify(inputSchema)) } } },
    responses: { "200": { description: "Server-rendered review preview or delivery status", content: { "text/vnd.turbo-stream.html": { schema: { type: "string" } } } }, "409": { description: "Comments changed or earlier delivery needs checking" } },
  },
}]));
