import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, globalWorkspaceConfiguration } from "../src/workspace-template.ts";
import { defaultChangeBuckets, effectiveChangeBuckets, getChangeBuckets, parseChangeBuckets, setChangeBuckets } from "../src/change-buckets.ts";

async function withStore(run: (file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-change-buckets-"));
  try { await run(join(directory, "projects.json")); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("lines name a bucket and list its patterns", () => {
  expect(parseChangeBuckets("# ours\n\nTests:  *Test.*   tests/ !testdata/\nDocs:\n")).toEqual([
    { name: "Tests", patterns: ["*Test.*", "tests/", "!testdata/"] },
    { name: "Docs", patterns: [] },
  ]);
  expect(parseChangeBuckets(defaultChangeBuckets).map(bucket => bucket.name)).toEqual(["Tests", "Evals"]);
});

test("unreadable lines are rejected", () => {
  for (const [input, message] of [
    ["*.test.ts", "Start each line with a bucket name"],
    [": *.test.ts", "Start each line with a bucket name"],
    ["Tests: a\ntests: b", "more than one bucket called “tests”"],
    ["Tests: !", "doesn’t match any files"],
  ] as const) expect(() => parseChangeBuckets(input), input).toThrow(message);
});

test("global defaults apply until saved, and a template's bucket replaces the global one with its name", () => withStore(async (file) => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/example/app.git", file);
  expect(await getChangeBuckets(globalWorkspaceConfiguration, file)).toBe(defaultChangeBuckets);
  expect(await getChangeBuckets(workspaceTemplate.id, file)).toBe("");
  expect((await effectiveChangeBuckets(workspaceTemplate.id, file)).map(bucket => bucket.name)).toEqual(["Tests", "Evals"]);

  await setChangeBuckets(workspaceTemplate.id, "Evals: graders/\nDocs: *.md", file);
  expect(await effectiveChangeBuckets(workspaceTemplate.id, file)).toEqual([
    parseChangeBuckets(defaultChangeBuckets)[0]!,
    { name: "Evals", patterns: ["graders/"] },
    { name: "Docs", patterns: ["*.md"] },
  ]);
  expect((await effectiveChangeBuckets(undefined, file)).map(bucket => bucket.name)).toEqual(["Tests", "Evals"]);
  await setChangeBuckets(workspaceTemplate.id, "Tests:\nEvals: graders/\nDocs: *.md", file);
  expect((await effectiveChangeBuckets(workspaceTemplate.id, file)).map(bucket => bucket.name)).toEqual(["Evals", "Docs"]);
  await setChangeBuckets(workspaceTemplate.id, "Evals: graders/\nDocs: *.md", file);

  expect(await setChangeBuckets(globalWorkspaceConfiguration, "", file)).toBe("");
  expect((await effectiveChangeBuckets(workspaceTemplate.id, file)).map(bucket => bucket.name)).toEqual(["Evals", "Docs"]);
  expect(await setChangeBuckets(workspaceTemplate.id, " \n", file)).toBe("");
  expect(await effectiveChangeBuckets(workspaceTemplate.id, file)).toEqual([]);
  await expect(setChangeBuckets(workspaceTemplate.id, "oops", file)).rejects.toThrow("Start each line");
}));
