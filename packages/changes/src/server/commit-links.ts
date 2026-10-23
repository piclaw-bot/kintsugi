import { escapeHtml, isCommitHash, shortCommit, type CommitLinkTarget } from "@kintsugi/shared";
import { git, type Repository } from "@kintsugi/workspace/git";
import { refreshChanges } from "./refresh.ts";
import { captureChanges, captureHistory, loadHistoryThrough, stagedChanges, workingTree, type ChangesHistory, type ChangesSnapshot, type DiffEndpoints } from "./snapshot.ts";

/** A link that can't be shown; its message is shown in Changes. */
class CommitLinkError extends Error {}

async function commitId(root: Repository, hash: string): Promise<string | undefined> {
  return (await git(root, ["rev-parse", "--verify", "--quiet", `${hash}^{commit}`], true)).toString().trim() || undefined;
}

async function snapshotId(root: Repository, history: ChangesHistory, endpoint: string): Promise<string> {
  if (endpoint === "working") return workingTree;
  if (endpoint === "staged") {
    // With nothing staged, the index is exactly HEAD.
    if (history.hasStaged) return stagedChanges;
    if (!history.head) throw new CommitLinkError("Nothing is staged right now.");
    return history.head;
  }
  const id = await commitId(root, endpoint);
  if (!id) throw new CommitLinkError(`Commit ${shortCommit(endpoint)} isn’t in this repository.`);
  if (!history.topology.some(commit => commit.id === id)) throw new CommitLinkError(`Commit ${shortCommit(endpoint)} isn’t on any local branch.`);
  return id;
}

async function linkEndpoints(root: Repository, history: ChangesHistory, link: CommitLinkTarget): Promise<DiffEndpoints> {
  const [base, target] = await Promise.all([link.base && snapshotId(root, history, link.base), snapshotId(root, history, link.target)]);
  // A live snapshot on its own is everything since HEAD, like Changes' default view; a commit on its own uses its parent.
  const endpoints: DiffEndpoints = base !== undefined ? { base, target } : isCommitHash(link.target) ? { target } : { target, base: history.head ?? null };
  if (endpoints.base === target) throw new CommitLinkError(link.base === "staged" || link.target === "staged" ? "Nothing is staged right now." : "Both ends of this link are the same commit.");
  return endpoints;
}

/** Show a commit link's comparison on a freshly captured history, or keep the current one with a notice. */
export async function openCommitLink(root: Repository, previous: ChangesSnapshot, link: CommitLinkTarget): Promise<ChangesSnapshot> {
  const history = await captureHistory(root);
  try {
    const endpoints = await linkEndpoints(root, history, link);
    await loadHistoryThrough(root, history, [endpoints.target, endpoints.base]);
    return await captureChanges(root, endpoints, history);
  } catch (error) {
    if (!(error instanceof CommitLinkError)) throw error;
    const snapshot = await refreshChanges(root, previous);
    snapshot.notice = error.message;
    return snapshot;
  }
}

/** The subject of a commit, or the size of a range between two commits. Undefined when a commit doesn't exist. */
export async function commitLinkLabel(root: Repository, link: CommitLinkTarget): Promise<string | undefined> {
  if (link.base === undefined) {
    const output = await git(root, ["show", "--no-patch", "--format=%s", `${link.target}^{commit}`, "--"], true);
    return output.length ? escapeHtml(output.toString("utf8").trim()) : undefined;
  }
  const [base, target] = await Promise.all([commitId(root, link.base), commitId(root, link.target)]);
  if (!base || !target) return undefined;
  const count = async (from: string, to: string) => Number((await git(root, ["rev-list", "--count", "--ancestry-path", `${from}..${to}`, "--"])).toString().trim());
  // Ancestry, not the order the link names them in, decides the direction.
  const commits = await count(base, target) || await count(target, base);
  return commits ? `· ${commits} ${commits === 1 ? "commit" : "commits"}` : "";
}
