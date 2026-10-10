import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, type Repository } from "@kintsugi/workspace/git";
import { localRepository } from "../../workspace/test/support/local-repository.ts";
import { inspectWorkspaceDeleteSafety } from "../src/deletion-safety.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-delete-safety-"));
  directories.push(root);
  const repo = localRepository(root);
  const inspect = () => inspectWorkspaceDeleteSafety(path => localRepository(join(root, path)));
  return { root, repo, inspect };
}
async function initialize(repo: Repository) {
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
}
async function commit(repo: Repository, message: string) {
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--allow-empty", "-m", message]);
  return (await git(repo, ["rev-parse", "HEAD"])).toString().trim();
}

test("non-Git and clean unborn repositories are clear; untracked names remain literal data", async () => {
  const { root, repo, inspect } = await fixture();
  expect(await inspect()).toEqual([]);
  await initialize(repo);
  expect(await inspect()).toEqual([]);
  const path = "odd\n'$(touch injected).txt";
  await writeFile(join(root, path), "new\n");
  expect(await inspect()).toEqual([{ repo: "work", uncommittedPaths: [path], unpushedCommits: [] }]);
  expect(await Bun.file(join(root, "injected")).exists()).toBe(false);
});

test("deletion checks use local remote refs, including other branches and detached HEAD, without fetching", async () => {
  const { repo, inspect } = await fixture();
  await initialize(repo);
  const base = await commit(repo, "base");
  await git(repo, ["update-ref", "refs/remotes/origin/main", base]);
  await git(repo, ["config", "remote.origin.url", "/must-not-contact"]);
  expect(await inspect()).toEqual([]);
  await git(repo, ["checkout", "-b", "side"]);
  const side = await commit(repo, "side");
  await git(repo, ["checkout", "--detach", base]);
  const detached = await commit(repo, "detached");
  const issues = await inspect();
  expect(issues).toHaveLength(1);
  expect(issues[0]!.unpushedCommits).toEqual(expect.arrayContaining([{ hash: side, subject: "side", branches: ["side"] }, { hash: detached, subject: "detached", branches: [] }]));
  expect(issues[0]!.unpushedCommits).toHaveLength(2);
});

test("root and initialized nested submodules share inspection, including renamed paths", async () => {
  const parent = await fixture();
  const child = await fixture();
  const grandchild = await fixture();
  for (const fixture of [parent, child, grandchild]) {
    await initialize(fixture.repo);
    await writeFile(join(fixture.root, "file"), "initial\n");
    await commit(fixture.repo, "initial");
  }
  await git(child.repo, ["-c", "protocol.file.allow=always", "submodule", "add", grandchild.root, "nested"]);
  await commit(child.repo, "nested submodule");
  await git(parent.repo, ["-c", "protocol.file.allow=always", "submodule", "add", child.root, "child with spaces"]);
  await git(parent.repo, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
  await commit(parent.repo, "child submodule");
  await git(parent.repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(parent.repo, ["mv", "file", "renamed file"]);
  await writeFile(join(parent.root, "child with spaces", "nested", "untracked"), "new\n");
  const issues = await parent.inspect();
  expect(issues.find(issue => issue.repo === "work")!.uncommittedPaths).toContain("renamed file");
  expect(issues.find(issue => issue.repo === "child with spaces/nested")!.uncommittedPaths).toContain("untracked");
});

test("status and submodule enumeration failures are not treated as safe deletion", async () => {
  const { root, repo } = await fixture();
  await initialize(repo);
  const failed = (message: string) => ({ exitCode: 1, stderr: message, stdout: Buffer.alloc(0) });
  await expect(inspectWorkspaceDeleteSafety(() => ({
    ...repo,
    gitResult: args => args[0] === "submodule" ? Promise.resolve(failed("enumeration failed")) : repo.gitResult(args),
  }))).rejects.toThrow("enumeration failed");
  await writeFile(join(root, "file"), "new\n");
  await expect(inspectWorkspaceDeleteSafety(() => ({
    ...repo,
    gitResult: args => args[0] === "status" ? Promise.resolve(failed("status failed")) : repo.gitResult(args),
  }))).rejects.toThrow("status failed");
  await expect(inspectWorkspaceDeleteSafety(() => ({
    ...repo,
    gitResult: args => args[0] === "log" ? Promise.resolve(failed("log failed")) : repo.gitResult(args),
  }))).rejects.toThrow("log failed");
});

test("a corrupt repository config blocks inspection rather than reporting clear", async () => {
  const { root, repo, inspect } = await fixture();
  await initialize(repo);
  await writeFile(join(root, ".git/config"), "[invalid\n");
  await expect(inspect()).rejects.toThrow("bad config");
});
