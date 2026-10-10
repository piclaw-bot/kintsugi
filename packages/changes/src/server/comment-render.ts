import { buttonHtml } from "@kintsugi/design-system/button";
import { buttonConfirmationHtml } from "@kintsugi/design-system/button-confirmation";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { Icons } from "@kintsugi/design-system/icons";
import { domId, escapeHtml } from "@kintsugi/shared";
import { exportReviewComments, type ReviewComment, type CommentPlacement } from "../comments.ts";

export const commentsModelId = (snapshotId: string) => domId("changes", snapshotId, "comments_model");
export const orphanCommentsId = (snapshotId: string) => domId("changes", snapshotId, "orphans");
export const commentsActionsId = (snapshotId: string) => domId("changes", snapshotId, "comment_actions");
export const commentsCopyId = (key: string) => domId("changes", key, "comments_copy");
const json = <Value>(value: Value) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
export function renderCommentsModel(snapshotId: string, comments: readonly CommentPlacement[]): string {
  return `<script id="${commentsModelId(snapshotId)}" type="application/json" data-changes-target="commentsModel">${json(comments)}</script>`;
}
export function renderCopyComments(workspaceId: string, key: string, comments: readonly CommentPlacement[]): string {
  const caption = `Copy ${comments.length} ${comments.length === 1 ? "comment" : "comments"}`;
  return `<div id="${commentsCopyId(key)}" class="changes-review-copy" data-controller="review-copy" data-review-copy-workspace-id-value="${escapeHtml(workspaceId)}">${comments.length ? buttonConfirmationHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption, iconHtml: Icons.Copy }, confirmationLabel: `Copied ${comments.length} ${comments.length === 1 ? "comment" : "comments"}`, attributesHtml: 'data-action="review-copy#copy" data-review-copy-target="button"' }) : ""}<script type="application/json" data-review-copy-target="model">${json({ text: exportReviewComments(comments), versions: comments.map(({ id, revision }) => ({ id, revision })) })}</script><span class="changes-copy-error" data-review-copy-target="error" role="alert" hidden></span></div>`;
}
export function renderCopyCommentButton(): string {
  return buttonConfirmationHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Copy, label: "Copy to clipboard" }, confirmationLabel: "Copied to clipboard", attributesHtml: 'data-action="changes#copyComment"' });
}

export function renderCommentActions(workspaceId: string, snapshotId: string, comments: readonly CommentPlacement[]): string {
  const caption = `Delete ${comments.length} ${comments.length === 1 ? "comment" : "comments"}`;
  const remove = comments.length ? `<form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/changes/comments/delete-many" data-action="submit->changes#deleteComments"><input type="hidden" name="versions" value="${escapeHtml(JSON.stringify(comments.map(({ id, revision }) => ({ id, revision }))))}">${destructiveConfirmationHtml({ id: domId("changes", snapshotId, "delete_comments"), trigger: { type: "button", variant: "danger", content: { kind: "caption", caption } }, confirmCaption: "Delete comments", cancelCaption: "Cancel" })}</form>` : "";
  return `<div id="${commentsActionsId(snapshotId)}" class="changes-comment-actions">${comments.length ? `${renderCopyComments(workspaceId, snapshotId, comments)}${remove}` : ""}</div>`;
}

export function renderOrphanComments(snapshotId: string, comments: readonly CommentPlacement[]): string {
  const orphans = comments.filter(comment => comment.status !== "inline");
  const contentId = domId("changes", snapshotId, "orphan_content");
  const entries = orphans.map(comment => {
    const location = `${comment.side === "additions" ? "New" : "Old"} ${comment.start === comment.end ? `line ${comment.start}` : `lines ${comment.start}–${comment.end}`}`;
    const status = comment.status === "other" ? "Another comparison" : "Code has changed";
    const edit = contentRowHtml({ width: "fill", kind: "multiline", label: { kind: "text", text: comment.body }, description: `${comment.path} · ${comment.comparison.label} · ${location} · ${status}`, element: { tag: "button", attributesHtml: 'type="button" aria-label="Edit comment" data-action="changes#editComment"' } });
    const remove = buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Trash, label: "Delete comment" }, attributesHtml: 'data-action="changes#deleteComment"' });
    return `<article data-comment-id="${escapeHtml(comment.id)}" class="changes-comment changes-comment-card changes-review-entry">${edit}<div class="changes-comment-tools">${renderCopyCommentButton()}${remove}</div></article>`;
  }).join("");
  const heading = `<div class="changes-file-header">${contentRowHtml({ width: "fill", kind: "compact", leadingHtml: Icons.Disclosure, label: { kind: "text", text: "Orphan comments" }, trailingHtml: `<span class="changes-orphan-count">${orphans.length}</span>`, element: { tag: "button", attributesHtml: `type="button" data-changes-target="orphanDisclosure" data-action="changes#toggleOrphans" aria-expanded="true" aria-controls="${contentId}"` } })}</div>`;
  return `<section id="${orphanCommentsId(snapshotId)}" class="changes-orphan-file">${orphans.length ? `${heading}<div id="${contentId}" data-changes-target="orphanContent">${entries}</div>` : ""}</section>`;
}

export const deletionCommentsId = (workspaceId: string) => domId("deletion", workspaceId, "review_comments");
export function renderDeletionComments(workspaceId: string, comments: readonly ReviewComment[]): string {
  comments = comments.filter(comment => comment.copiedRevision !== comment.revision);
  const message = `${comments.length} review ${comments.length === 1 ? "comment hasn’t" : "comments haven’t"} been copied. Deleting this workspace will delete ${comments.length === 1 ? "it" : "them"}.`;
  return `<section id="${deletionCommentsId(workspaceId)}" class="changes-deletion-comments">${comments.length ? `<h2>Review comments</h2><p>${escapeHtml(message)}</p>${renderCopyComments(workspaceId, `deletion-${workspaceId}`, comments.map(comment => ({ ...comment, status: "other" })))}` : ""}</section>`;
}
