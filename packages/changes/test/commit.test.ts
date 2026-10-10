import { localRepository } from "../../workspace/test/support/local-repository.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectCommitChangesFile, collectCommitChangesStats } from "../src/server/diff.ts";
import { git } from "@kintsugi/workspace/git";
import { command, createChangesRepository } from "./support/repository.ts";

let root: string;
beforeEach(async () => { root = await createChangesRepository(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function commit(): Promise<string> {
  await command(root, "git", "add", "-A");
  await command(root, "git", "commit", "-qm", "changes");
  return (await git(localRepository(root), ["rev-parse", "HEAD"])).toString("utf8").trim();
}

test("root commits compare against an empty tree", async () => {
  const stats = await collectCommitChangesStats(localRepository(root), "HEAD");
  expect(stats).toContainEqual({ path: "changed.ts", change: "added", additions: 1, deletions: 0 });
  expect(await collectCommitChangesFile(localRepository(root), "HEAD", "changed.ts")).toMatchObject({ kind: "text", change: "added", newContents: "const before = true;\n" });
  expect(await collectCommitChangesFile(localRepository(root), "HEAD", "empty.txt")).toMatchObject({ kind: "mode", change: "added", detail: "Empty file added" });
});

test("commit diffs use committed contents, not the working tree", async () => {
  await writeFile(join(root, "changed.ts"), "const after = true;\n");
  await command(root, "git", "rm", "empty.txt");
  await writeFile(join(root, "new.txt"), "new\n");
  const hash = await commit();
  await writeFile(join(root, "changed.ts"), "uncommitted\n");
  expect(await collectCommitChangesStats(localRepository(root), hash)).toEqual([
    { path: "changed.ts", change: "modified", additions: 1, deletions: 1 },
    { path: "empty.txt", change: "removed", additions: 0, deletions: 0 },
    { path: "new.txt", change: "added", additions: 1, deletions: 0 },
  ]);
  expect(await collectCommitChangesFile(localRepository(root), hash, "changed.ts")).toMatchObject({ kind: "text", oldContents: "const before = true;\n", newContents: "const after = true;\n" });
  expect(await collectCommitChangesFile(localRepository(root), hash, "empty.txt")).toMatchObject({ kind: "mode", change: "removed", detail: "Empty file deleted" });
  expect(await collectCommitChangesFile(localRepository(root), hash, "../outside")).toBeUndefined();
});

test("commit diffs retain renames, modes, binary sizes, and symlinks", async () => {
  await command(root, "git", "mv", "changed.ts", "renamed.ts");
  await chmod(join(root, "empty.txt"), 0o755);
  await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
  await symlink("renamed.ts", join(root, "link"));
  const hash = await commit();
  expect(await collectCommitChangesStats(localRepository(root), hash)).toEqual(expect.arrayContaining([
    { path: "renamed.ts", previousPath: "changed.ts", change: "modified", additions: 0, deletions: 0 },
    { path: "binary.dat", change: "added", additions: 0, deletions: 0, binarySizes: { before: undefined, after: 3 } },
  ]));
  expect(await collectCommitChangesFile(localRepository(root), hash, "renamed.ts")).toMatchObject({ previousPath: "changed.ts", kind: "mode", detail: "File renamed" });
  expect(await collectCommitChangesFile(localRepository(root), hash, "empty.txt")).toMatchObject({ kind: "mode", detail: "File mode changed" });
  expect(await collectCommitChangesFile(localRepository(root), hash, "binary.dat")).toMatchObject({ kind: "binary" });
  expect(await collectCommitChangesFile(localRepository(root), hash, "link")).toMatchObject({ kind: "text", newContents: "renamed.ts" });
});

test("merge commits compare against their first parent and empty commits have no files", async () => {
  await command(root, "git", "checkout", "-qb", "feature");
  await writeFile(join(root, "feature.txt"), "feature\n");
  await commit();
  await command(root, "git", "checkout", "-");
  await command(root, "git", "merge", "--no-ff", "-m", "merge feature", "feature");
  expect(await collectCommitChangesStats(localRepository(root), "HEAD")).toEqual([{ path: "feature.txt", change: "added", additions: 1, deletions: 0 }]);
  await command(root, "git", "commit", "--allow-empty", "-qm", "empty");
  expect(await collectCommitChangesStats(localRepository(root), "HEAD")).toEqual([]);
});
