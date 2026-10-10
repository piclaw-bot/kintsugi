import { KintsugiCoreError, collectUnpushedCommits, type UnpushedCommit, type JsonObject } from "@kintsugi/core";
import { repositoryPaths, parseGitStatus, type Repository } from "@kintsugi/workspace/git";

interface WorkspaceDeleteSafetyIssue extends JsonObject { repo: string; uncommittedPaths: string[]; unpushedCommits: UnpushedCommit[] }

async function inspectRepositoryDeleteSafety(root: Repository, repoName: string): Promise<WorkspaceDeleteSafetyIssue | null> {
  const status = await root.gitResult(["status", "--porcelain=v1", "-z"]);
  if (status.exitCode !== 0) throw new KintsugiCoreError("git_error", status.stderr.trim() || `could not check status for ${repoName}`);
  const unpushedCommits = await collectUnpushedCommits(args => root.gitResult(args));
  const issue = { repo: repoName, uncommittedPaths: parseGitStatus(status.stdout).map(entry => entry.path), unpushedCommits };
  return issue.uncommittedPaths.length || issue.unpushedCommits.length ? issue : null;
}

export async function inspectWorkspaceDeleteSafety(repositoryFor: (relativePath: string) => Repository): Promise<WorkspaceDeleteSafetyIssue[]> {
  const repositories = await repositoryPaths(repositoryFor(""));
  const issues: WorkspaceDeleteSafetyIssue[] = [];
  for (const repository of repositories) {
    const issue = await inspectRepositoryDeleteSafety(repositoryFor(repository), repository || "work");
    if (issue) issues.push(issue);
  }
  return issues;
}
