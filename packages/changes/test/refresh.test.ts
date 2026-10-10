import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@kintsugi/workspace/git";
import { localRepository } from "../../workspace/test/support/local-repository.ts";
import { captureChanges, workingTree } from "../src/server/snapshot.ts";
import { refreshChanges } from "../src/server/refresh.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "changes-refresh-"));
  roots.push(root);
  const repo = localRepository(root);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Changes Test"]);
  await git(repo, ["config", "user.email", "changes@example.com"]);
  await writeFile(join(root, "file.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Base"]);
  return { root, repo };
}

test("refresh updates synthetic layers without mutating the previous comparison", async () => {
  const { root, repo } = await repository();
  const clean = await captureChanges(repo);
  await writeFile(join(root, "file.txt"), "staged\n");
  await git(repo, ["add", "."]);
  const staged = await refreshChanges(repo, clean);
  expect(clean.endpoints).toEqual({ target: workingTree, base: clean.history.head });
  expect(staged.endpoints).toEqual({ target: workingTree, base: clean.history.head });
  expect(staged.history.hasStaged).toBe(true);
  expect(staged.files.get("file.txt")!.newContents).toBe("staged\n");
  await git(repo, ["commit", "-m", "Agent commit"]);
  await writeFile(join(root, "new.txt"), "working\n");
  const committed = await refreshChanges(repo, staged);
  expect(staged.endpoints).toEqual({ target: workingTree, base: clean.history.head });
  expect(committed.endpoints).toEqual({ target: workingTree, base: committed.history.head });
  expect(committed.history.hasStaged).toBe(false);
  expect(committed.history.commits[0]!.stats).toEqual({ files: 1, additions: 1, deletions: 0 });
  expect([...committed.files.keys()]).toEqual(["new.txt"]);
});

test("refresh follows new unpushed commits but preserves an explicit commit comparison", async () => {
  const { root, repo } = await repository();
  await git(repo, ["branch", "tracking"]);
  await git(repo, ["config", "branch.main.remote", "."]);
  await git(repo, ["config", "branch.main.merge", "refs/heads/tracking"]);
  const trackingClean = await captureChanges(repo);
  await writeFile(join(root, "file.txt"), "first\n");
  await git(repo, ["commit", "-am", "First ahead"]);
  const previous = await refreshChanges(repo, trackingClean);
  expect(previous.endpoints.base).toBe(trackingClean.history.head);
  const first = previous.history.head!;
  const explicit = await captureChanges(repo, { target: first });
  await writeFile(join(root, "file.txt"), "second\n");
  await git(repo, ["commit", "-am", "Second ahead"]);
  const refreshed = await refreshChanges(repo, previous);
  expect(refreshed.endpoints.base).toBe(trackingClean.history.head);
  expect(refreshed.history.head).not.toBe(previous.history.head);
  expect(refreshed.history.unpushed!.count).toBe(2);
  expect(refreshed.files.get("file.txt")!.oldContents).toBe("base\n");
  expect(refreshed.files.get("file.txt")!.newContents).toBe("second\n");
  const pinned = await refreshChanges(repo, explicit);
  expect(pinned.endpoints).toEqual(explicit.endpoints);
  expect(pinned.files.get("file.txt")!.newContents).toBe("first\n");
});
