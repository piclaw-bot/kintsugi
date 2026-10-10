import { KintsugiCoreError } from "./errors.ts";

export type UnpushedCommit = { hash: string; subject: string; branches: string[] };

/** Commits reachable from local branches or detached HEAD, but no known remote branch.
 * Uses local remote-tracking refs only; an unborn HEAD is ignored.
 */
export async function collectUnpushedCommits(
  runGit: (args: string[]) => Promise<{ stdout: string | Buffer; stderr: string; exitCode: number }>,
): Promise<UnpushedCommit[]> {
  const result = await runGit(["log", "--format=%H%x00%s", "--ignore-missing", "HEAD", "--branches", "--not", "--remotes", "--"]);
  if (result.exitCode !== 0) throw new KintsugiCoreError("git_error", result.stderr.trim() || "could not check unpushed commits");
  const commits: UnpushedCommit[] = [];
  for (const line of result.stdout.toString().split("\n").filter(Boolean)) {
    const separator = line.indexOf("\0");
    const hash = line.slice(0, separator);
    const branches = await runGit(["for-each-ref", "--format=%(refname:lstrip=2)", `--contains=${hash}`, "refs/heads/"]);
    if (branches.exitCode !== 0) throw new KintsugiCoreError("git_error", branches.stderr.trim() || "could not check commit branches");
    commits.push({ hash, subject: line.slice(separator + 1), branches: branches.stdout.toString().split("\n").filter(Boolean) });
  }
  return commits;
}
