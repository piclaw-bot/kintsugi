import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncWorkspaceDocs } from "../src/server/workspace-docs.ts";

const buildCommit = "0123456789abcdef0123456789abcdef01234567";
const sourceLine = `\n\nIf you cannot find the answer to your question here, you can find the source code of this version of Kintsugi here: [GitHub](https://github.com/rcarmo/kintsugi) · [0123456](https://github.com/rcarmo/kintsugi/commit/${buildCommit})\n`;

let root: string;
let destination: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kintsugi-docs-"));
  destination = join(root, "installed");
  await mkdir(join(root, "docs/deploy-in-workspace"), { recursive: true });
  await mkdir(join(root, "packages/without-docs"), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function source(path: string, content: string): Promise<void> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

test("deploys shared and package documentation with relative paths and read-only files", async () => {
  await source("docs/deploy-in-workspace/kintsugi.md", "Shared guide");
  await source("packages/inline-content/deploy-in-workspace/inline-content.md", "Rich guide");
  await source("packages/example/deploy-in-workspace/examples/usage.md", "Nested guide");
  await syncWorkspaceDocs(root, destination, buildCommit);
  expect(await readFile(join(destination, "kintsugi.md"), "utf8")).toBe("Shared guide" + sourceLine);
  expect(await readFile(join(destination, "inline-content.md"), "utf8")).toBe("Rich guide" + sourceLine);
  expect(await readFile(join(destination, "examples/usage.md"), "utf8")).toBe("Nested guide" + sourceLine);
  expect((await stat(join(destination, "inline-content.md"))).mode & 0o777).toBe(0o444);
});

test("updates and removes docs without replacing mounted directories", async () => {
  await source("packages/example/deploy-in-workspace/examples/usage.md", "First");
  await source("packages/example/deploy-in-workspace/obsolete/old.md", "Old");
  await syncWorkspaceDocs(root, destination, buildCommit);
  const rootInode = (await stat(destination)).ino;
  const nestedInode = (await stat(join(destination, "examples"))).ino;
  await source("packages/example/deploy-in-workspace/examples/usage.md", "Revised");
  await rm(join(root, "packages/example/deploy-in-workspace/obsolete"), { recursive: true });
  await syncWorkspaceDocs(root, destination, buildCommit);
  expect(await readFile(join(destination, "examples/usage.md"), "utf8")).toBe("Revised" + sourceLine);
  expect((await stat(destination)).ino).toBe(rootInode);
  expect((await stat(join(destination, "examples"))).ino).toBe(nestedInode);
  expect(await Bun.file(join(destination, "obsolete/old.md")).exists()).toBe(false);
});

test("rejects duplicate destinations before modifying installed docs", async () => {
  await source("docs/deploy-in-workspace/guide.md", "Original");
  await syncWorkspaceDocs(root, destination, buildCommit);
  await source("docs/deploy-in-workspace/guide.md", "Changed");
  await source("packages/example/deploy-in-workspace/guide.md", "Conflicting");
  await expect(syncWorkspaceDocs(root, destination, buildCommit)).rejects.toThrow("Conflicting workspace documentation path: guide.md");
  expect(await readFile(join(destination, "guide.md"), "utf8")).toBe("Original" + sourceLine);
});

test("rejects file versus directory collisions", async () => {
  await source("docs/deploy-in-workspace/examples", "A file");
  await source("packages/example/deploy-in-workspace/examples/usage.md", "A directory");
  await expect(syncWorkspaceDocs(root, destination, buildCommit)).rejects.toThrow("Conflicting workspace documentation path: examples");
});

test("labels local development builds and leaves non-Markdown assets unchanged", async () => {
  await source("docs/deploy-in-workspace/guide.md", "# Guide\n");
  await source("packages/example/deploy-in-workspace/example.txt", "Example");
  await syncWorkspaceDocs(root, destination, "");
  expect(await readFile(join(destination, "guide.md"), "utf8")).toBe(
    "# Guide\n\n\nIf you cannot find the answer to your question here, you can find the source code of this version of Kintsugi here: [GitHub](https://github.com/rcarmo/kintsugi) · local development build\n",
  );
  expect(await readFile(join(destination, "example.txt"), "utf8")).toBe("Example");
});
