import { localRepository } from "../../workspace/test/support/local-repository.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureChanges, captureHistory, commitHistory } from "../src/server/snapshot.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function git(root: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const error = await new Response(process.stderr).text();
  if (await process.exited !== 0) throw new Error(error);
}
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "changes-snapshot-"));
  roots.push(root);
  await git(root, "init");
  await git(root, "config", "user.name", "Changes Test");
  await git(root, "config", "user.email", "changes@example.com");
  return root;
}

test("captures staged, unstaged, untracked, removed and renamed files without changing Git", async () => {
  const root = await repository();
  await mkdir(join(root, "src"));
  for (const name of ["staged", "unstaged", "removed", "renamed"]) await writeFile(join(root, `src/${name}.ts`), `export const ${name} = 1;\n`);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Initial");
  await writeFile(join(root, "src/staged.ts"), "export const staged = 2;\n");
  await git(root, "add", "src/staged.ts");
  await writeFile(join(root, "src/unstaged.ts"), "export const unstaged = 2;\n");
  await writeFile(join(root, "src/new.ts"), "export const added = true;\n");
  await rm(join(root, "src/removed.ts"));
  await git(root, "mv", "src/renamed.ts", "src/moved.ts");
  const snapshot = await captureChanges(localRepository(root));
  expect(snapshot.index.phase).toBe("ready");
  expect([...snapshot.files.keys()].sort()).toEqual(["src/moved.ts", "src/new.ts", "src/removed.ts", "src/staged.ts", "src/unstaged.ts"]);
  expect(snapshot.files.get("src/staged.ts")!.oldContents).toBe("export const staged = 1;\n");
  expect(snapshot.files.get("src/staged.ts")!.newContents).toBe("export const staged = 2;\n");
  expect(snapshot.files.get("src/moved.ts")!.previousPath).toBe("src/renamed.ts");
  expect(snapshot.files.get("src/removed.ts")!.change).toBe("removed");
  for (const file of snapshot.files.values()) if (file.diff) expect(file.diff.cacheKey).toBe(`${snapshot.id}:${file.path}`);
  await writeFile(join(root, "src/unstaged.ts"), "export const unstaged = 3;\n");
  expect(snapshot.files.get("src/unstaged.ts")!.newContents).toBe("export const unstaged = 2;\n");
  const next = await captureChanges(localRepository(root));
  expect(next.id).not.toBe(snapshot.id);
  expect(next.files.get("src/unstaged.ts")!.newContents).toBe("export const unstaged = 3;\n");
});

test("captures binary and oversized files without creating text diffs", async () => {
  const root = await repository();
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 0, 1]));
  await writeFile(join(root, "large.txt"), "line\n".repeat(5_001));
  const snapshot = await captureChanges(localRepository(root));
  expect(snapshot.files.get("binary.bin")!.kind).toBe("binary");
  expect(snapshot.files.get("large.txt")!.kind).toBe("large");
  expect(snapshot.files.get("binary.bin")!.diff).toBeUndefined();
  expect(snapshot.files.get("large.txt")!.diff).toBeUndefined();
});

test("handles clean and non-Git directories", async () => {
  const root = await repository();
  expect((await captureChanges(localRepository(root))).files.size).toBe(0);
  const empty = await mkdtemp(join(tmpdir(), "changes-no-git-"));
  roots.push(empty);
  expect((await captureChanges(localRepository(empty))).index.phase).toBe("not-git");
});

test("history keeps multi-line commit bodies with their subject", async () => {
  const root = await repository();
  await writeFile(join(root, "a.txt"), "a\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "First subject", "-m", "Line one\n\nLine three");
  await writeFile(join(root, "b.txt"), "b\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Second subject");
  const history = await captureHistory(localRepository(root));
  const commits = history.commits.filter(commit => commit.kind === "commit").map(({ subject, body }) => ({ subject, body }));
  const expected = [{ subject: "Second subject", body: "" }, { subject: "First subject", body: "Line one\n\nLine three" }];
  expect(commits).toEqual(expected);
  expect((await commitHistory(localRepository(root), history)).commits.map(({ subject, body }) => ({ subject, body }))).toEqual(expected);
});

test("image comparisons capture immutable before/after bytes, including renamed, added, deleted and staged images", async () => {
  const root = await repository();
  const before = Buffer.from([137, 80, 78, 71, 0, 1]);
  const after = Buffer.from([137, 80, 78, 71, 0, 2]);
  await writeFile(join(root, "card.PNG"), before);
  await writeFile(join(root, "removed.png"), before);
  await writeFile(join(root, "rename.png"), Buffer.concat([before, Buffer.from("rename")]));
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Images");
  await git(root, "mv", "rename.png", "renamed.png");
  await writeFile(join(root, "card.PNG"), after);
  await writeFile(join(root, "added.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await rm(join(root, "removed.png"));
  await git(root, "add", ".");
  const snapshot = await captureChanges(localRepository(root));
  const image = snapshot.files.get("card.PNG")!;
  expect(image.kind).toBe("binary");
  expect(image.diff).toBeUndefined();
  expect(image.images?.before).toEqual({ contents: before, contentType: "image/png" });
  expect(image.images?.after).toEqual({ contents: after, contentType: "image/png" });
  expect(snapshot.files.get("added.svg")!.images?.before).toBeUndefined();
  expect(snapshot.files.get("added.svg")!.images?.after?.contentType).toBe("image/svg+xml");
  expect(snapshot.files.get("removed.png")!.images?.before?.contents).toEqual(before);
  expect(snapshot.files.get("removed.png")!.images?.after).toBeUndefined();
  expect(snapshot.files.get("renamed.png")!.previousPath).toBe("rename.png");
  expect(snapshot.files.get("renamed.png")!.images?.before?.contents).toEqual(Buffer.concat([before, Buffer.from("rename")]));
  await writeFile(join(root, "card.PNG"), Buffer.from([0, 3]));
  expect(image.images?.after?.contents).toEqual(after);
  const staged = await captureChanges(localRepository(root), { target: "staged" }, snapshot.history);
  expect(staged.files.get("card.PNG")!.images?.after?.contents).toEqual(after);
});
