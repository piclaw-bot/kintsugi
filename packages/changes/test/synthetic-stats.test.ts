import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@kintsugi/workspace/git";
import { localRepository } from "../../workspace/test/support/local-repository.ts";
import { captureChanges, stagedChanges, workingTree } from "../src/server/snapshot.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "changes-synthetic-"));
  roots.push(root);
  const repo = localRepository(root);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Changes Test"]);
  await git(repo, ["config", "user.email", "changes@example.com"]);
  return { root, repo };
}

test("clean repositories always have a zero-stats working row and no staged row", async () => {
  const { root, repo } = await repository();
  const unborn = await captureChanges(repo);
  expect(unborn.history.commits.map(commit => commit.id)).toEqual([workingTree]);
  expect(unborn.history.commits[0]!.stats).toEqual({ files: 0, additions: 0, deletions: 0 });
  await writeFile(join(root, "file.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Base"]);
  const clean = await captureChanges(repo);
  expect(clean.history.hasStaged).toBe(false);
  expect(clean.history.commits.some(commit => commit.kind === "staged")).toBe(false);
  expect(clean.history.commits[0]!.stats).toEqual({ files: 0, additions: 0, deletions: 0 });
  expect(clean.history.commits.filter(commit => commit.kind === "commit").every(commit => commit.stats === undefined)).toBe(true);
});

test("synthetic totals describe separate staged and working layers, including untracked text, binary and empty files", async () => {
  const { root, repo } = await repository();
  await writeFile(join(root, "file.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Base"]);
  await writeFile(join(root, "file.txt"), "staged\nsecond\n");
  await git(repo, ["add", "file.txt"]);
  const stagedOnly = await captureChanges(repo);
  expect(stagedOnly.history.commits.find(commit => commit.id === stagedChanges)!.stats).toEqual({ files: 1, additions: 2, deletions: 1 });
  expect(stagedOnly.history.commits[0]!.stats).toEqual({ files: 0, additions: 0, deletions: 0 });
  await writeFile(join(root, "file.txt"), "working\n");
  await writeFile(join(root, "untracked.txt"), "first\nsecond");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 2, 3]));
  await writeFile(join(root, "empty.txt"), "");
  const before = await readFile(join(root, ".git/index"));
  const snapshot = await captureChanges(repo);
  expect(snapshot.history.commits.find(commit => commit.id === stagedChanges)!.stats).toEqual({ files: 1, additions: 2, deletions: 1 });
  expect(snapshot.history.commits[0]!.stats).toEqual({ files: 4, additions: 3, deletions: 2 });
  expect(await readFile(join(root, ".git/index"))).toEqual(before);
});

test("NUL-delimited staged rename stats count one file even with tabs and newlines in paths", async () => {
  const { root, repo } = await repository();
  await writeFile(join(root, "old\tname\n.txt"), "unchanged\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Base"]);
  await git(repo, ["mv", "old\tname\n.txt", "new\tname\n.txt"]);
  const snapshot = await captureChanges(repo);
  expect(snapshot.history.commits.find(commit => commit.id === stagedChanges)!.stats).toEqual({ files: 1, additions: 0, deletions: 0 });
  expect(snapshot.history.commits[0]!.stats).toEqual({ files: 0, additions: 0, deletions: 0 });
});
