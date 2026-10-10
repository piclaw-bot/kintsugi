import { reviewComments, type ReviewCommentStore } from "./comments.ts";
import { renderDeletionComments } from "./comment-render.ts";
import type { ReviewComment } from "../comments.ts";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { createHash } from "node:crypto";
import { collectUnpushedCommits, type UnpushedCommit } from "@kintsugi/core";
import { domId, escapeHtml, type WorkspaceDeletionAssessment, type WorkspaceDeletionReview } from "@kintsugi/shared";
import { response, textResponse } from "@kintsugi/shared/http";
import { collectCommitChangesFile, collectCommitChangesStats, collectChangesFile, collectChangesIndex, collectChangesStats, type ChangesFileStats } from "./diff.ts";
import { repositoryPaths, workspaceRepository, type Repository, git } from "@kintsugi/workspace/git";
import { renderFileStats, deletionFileSummary, renderDeletionFile } from "./deletion-render.ts";

type DeletionRepository = {
  relativePath: string;
  uncommitted: ChangesFileStats[];
  unpushedCommits: UnpushedCommit[];
};
type DeletionAssessment = {
  status: "blocked";
  fingerprint: string;
  details: { repositories: DeletionRepository[]; comments?: ReviewComment[] };
};

export function createDeletionReview(repositoryFor: (workspaceId: string, path: string) => Repository, comments?: ReviewCommentStore) {
  const assessments = new Map<string, DeletionAssessment>();

  async function inspect(workspaceId: string): Promise<WorkspaceDeletionAssessment> {
    const workspaceRoot = repositoryFor(workspaceId, "");
    const repositories: DeletionRepository[] = [];
    const fingerprintMaterial: string[] = [];
    for (const relativePath of await repositoryPaths(workspaceRoot)) {
      const root = repositoryFor(workspaceId, relativePath);
      const index = await collectChangesIndex(root);
      if (index.phase !== "ready") continue;
      const uncommitted = await collectChangesStats(root, index);
      const unpushedCommits = await collectUnpushedCommits((args) => root.gitResult(args));
      if (!uncommitted.length && !unpushedCommits.length) continue;
      repositories.push({ relativePath, uncommitted, unpushedCommits });
      if (!uncommitted.length) continue;
      const head = await root.gitResult(["rev-parse", "--verify", "HEAD"]);
      fingerprintMaterial.push(head.exitCode === 0 ? (await git(root, ["diff", "--binary", "HEAD", "--"])).toString("base64") : "no-head");
      for (const file of uncommitted.filter((candidate) => candidate.untracked)) {
        fingerprintMaterial.push(`${file.path}:${(await git(root, ["hash-object", "--no-filters", "--", file.path])).toString("utf8").trim()}`);
      }
    }
    const savedComments = (comments?.list(workspaceId) ?? []).filter(comment => comment.copiedRevision !== comment.revision);
    if (!repositories.length && !savedComments.length) {
      assessments.delete(workspaceId);
      return { status: "clear" };
    }
    const details: DeletionAssessment["details"] = { repositories };
    if (savedComments.length) details.comments = savedComments;
    const fingerprint = createHash("sha256").update(JSON.stringify({ repositories, comments: savedComments.map(({ copiedRevision: _copied, ...comment }) => comment) })).update(fingerprintMaterial.join("\0")).digest("hex");
    const assessment: DeletionAssessment = {
      status: "blocked",
      fingerprint,
      details,
    };
    assessments.set(workspaceId, assessment);
    return assessment;
  }

  function fileFrameId(workspaceId: string, fingerprint: string, repository: string, path: string, commit = ""): string {
    return domId("deletion_review", workspaceId, fingerprint, repository || "root", commit || "working", path);
  }

  function commitFrameId(workspaceId: string, fingerprint: string, repository: string, commit: string): string {
    return domId("deletion_commit", workspaceId, fingerprint, repository || "root", commit);
  }

  function lazyFrame(frameId: string, url: string): string {
    return `<turbo-frame id="${frameId}" data-src="${escapeHtml(url)}"><div class="deletion-file-loading" role="status"><span class="status-spinner" aria-hidden="true"></span> Loading changes…</div></turbo-frame>`;
  }

  function fileSummary(workspaceId: string, fingerprint: string, repository: string, file: ChangesFileStats, commit = ""): string {
    const frameId = fileFrameId(workspaceId, fingerprint, repository, file.path, commit);
    const query = new URLSearchParams({ fingerprint, repository, path: file.path, commit });
    const summary = deletionFileSummary(
      { kind: "text", text: file.path },
      `<span class="deletion-git-stats">${renderFileStats(file)}</span>`,
      file.path,
    );
    return `<div class="deletion-file">${disclosureHtml({ element: { attributesHtml: 'data-action="toggle->deletion-review#requestFile"' }, summary, bodyHtml: lazyFrame(frameId, `/workspaces/${encodeURIComponent(workspaceId)}/changes/deletion/file?${query}`) })}</div>`;
  }

  function fileList(workspaceId: string, fingerprint: string, repository: string, files: ChangesFileStats[], commit = ""): string {
    return `<div class="deletion-files action-list">${files.map((file) => fileSummary(workspaceId, fingerprint, repository, file, commit)).join("")}</div>`;
  }

  function commitSummary(workspaceId: string, fingerprint: string, repository: string, commit: UnpushedCommit): string {
    const branches = commit.branches.length ? commit.branches.join(", ") : "Detached HEAD";
    const summary = deletionFileSummary(
      { kind: "text", text: commit.subject },
      `<span class="workspace-deletion-commit-branches" title="${escapeHtml(branches)}">${escapeHtml(branches)}</span><code title="${escapeHtml(commit.hash)}">${escapeHtml(commit.hash.slice(0, 12))}</code>`,
    );
    const query = new URLSearchParams({ fingerprint, repository, commit: commit.hash });
    const frameId = commitFrameId(workspaceId, fingerprint, repository, commit.hash);
    return `<div class="deletion-file">${disclosureHtml({ element: { attributesHtml: 'data-action="toggle->deletion-review#requestFile"' }, summary, bodyHtml: lazyFrame(frameId, `/workspaces/${encodeURIComponent(workspaceId)}/changes/deletion/commit?${query}`) })}</div>`;
  }

  function renderEvidence(workspaceId: string): string {
    const assessment = assessments.get(workspaceId);
    if (!assessment) throw new Error("Deletion review assessment is no longer current");
    return `${renderDeletionComments(workspaceId, comments?.list(workspaceId) ?? [])}<div data-controller="deletion-review">${assessment.details.repositories.length ? "<p>You might lose:</p>" : ""}${assessment.details.repositories.map((repository) => {
      const { fingerprint } = assessment;
      const working = repository.uncommitted.length ? disclosureHtml({ open: true, summary: { kind: "compact", label: { kind: "text", text: "Uncommitted changes" }, attributesHtml: 'data-linear-navigation-target="item"' }, bodyHtml: fileList(workspaceId, fingerprint, repository.relativePath, repository.uncommitted) }) : "";
      const commits = repository.unpushedCommits.length ? `<div class="action-list">${repository.unpushedCommits.map((commit) => commitSummary(workspaceId, fingerprint, repository.relativePath, commit)).join("")}</div>` : "";
      const repositoryHeading = repository.relativePath ? `<h2>${escapeHtml(repository.relativePath)}</h2>` : "";
      return `<section class="workspace-deletion-repository">${repositoryHeading}${working}${commits}</section>`;
    }).join("")}</div>`;
  }

  const changesDeletionReview: WorkspaceDeletionReview = { inspect, renderEvidence };

  function reviewRequest(workspaceId: string, url: URL) {
    const assessment = assessments.get(workspaceId);
    const fingerprint = url.searchParams.get("fingerprint") ?? "";
    if (!assessment || assessment.fingerprint !== fingerprint) return textResponse("Deletion assessment is no longer current", { status: 409 });
    const relativePath = url.searchParams.get("repository") ?? "";
    const repository = assessment.details.repositories.find((candidate) => candidate.relativePath === relativePath);
    if (!repository) return textResponse("Review repository is no longer available", { status: 404 });
    const commit = url.searchParams.get("commit") ?? "";
    if (commit && !repository.unpushedCommits.some((candidate) => candidate.hash === commit)) return textResponse("Review commit is no longer available", { status: 404 });
    return { fingerprint, repository, commit, root: repositoryFor(workspaceId, relativePath) };
  }

  async function deletionReviewCommitResponse(workspaceId: string, url: URL): Promise<Response> {
    const context = reviewRequest(workspaceId, url);
    if (context instanceof Response) return context;
    const { fingerprint, repository, commit, root } = context;
    if (!commit) return textResponse("Review commit is required", { status: 400 });
    const files = await collectCommitChangesStats(root, commit);
    const frameId = commitFrameId(workspaceId, fingerprint, repository.relativePath, commit);
    const body = files.length ? fileList(workspaceId, fingerprint, repository.relativePath, files, commit) : '<p class="workspace-deletion-empty">This commit has no file changes.</p>';
    return response(`<turbo-frame id="${frameId}">${body}</turbo-frame>`);
  }

  async function deletionReviewFileResponse(workspaceId: string, url: URL): Promise<Response> {
    const context = reviewRequest(workspaceId, url);
    if (context instanceof Response) return context;
    const { fingerprint, repository, commit, root } = context;
    const path = url.searchParams.get("path") ?? "";
    if (!commit && !repository.uncommitted.some((file) => file.path === path)) return textResponse("Review file is no longer available", { status: 404 });
    const file = commit ? await collectCommitChangesFile(root, commit, path) : await collectChangesFile(root, path);
    if (!file) return textResponse("Review file is no longer available", { status: commit ? 404 : 409 });
    const frameId = fileFrameId(workspaceId, fingerprint, repository.relativePath, path, commit);
    return response(await renderDeletionFile(frameId, file));
  }

  function clearDeletionReview(workspaceId: string): void {
    assessments.delete(workspaceId);
  }

  return { changesDeletionReview, deletionReviewCommitResponse, deletionReviewFileResponse, clearDeletionReview };
}

export const { changesDeletionReview, deletionReviewCommitResponse, deletionReviewFileResponse, clearDeletionReview } = createDeletionReview(workspaceRepository, reviewComments);
