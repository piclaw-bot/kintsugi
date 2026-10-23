import { expect, test } from "bun:test";
import { defaultChangeBuckets, parseChangeBuckets } from "@kintsugi/workspace-templates";
import { bucketTotals, changeBucketMatcher } from "../src/server/buckets.ts";

test("default buckets find tests and evals across common conventions", () => {
  const match = changeBucketMatcher(parseChangeBuckets(defaultChangeBuckets));
  const tests = ["src/ThingTest.cs", "src/ThingTests.cs", "app/UserSpec.scala", "src/a.test.ts", "pkg/a_test.go", "b-spec.js", "test_api.py", "tests/helpers.py", "web/__tests__/x.tsx", "Project/Tests/Startup.cs", "spec/models/user_spec.rb"];
  const evals = ["evals/run.py", "src/RetrievalEval.cs", "agent/grader.eval.ts", "eval/data.jsonl"];
  const main = ["src/latest.ts", "src/contest.py", "src/Contest.cs", "src/evaluate.ts", "src/retrieval.py", "testing.md", "src/attestation.go"];
  for (const path of tests) expect(match(path), path).toBe(0);
  for (const path of evals) expect(match(path), path).toBe(1);
  for (const path of main) expect(match(path), path).toBeUndefined();
});

test("patterns follow gitignore conventions and the first matching bucket wins", () => {
  const match = changeBucketMatcher(parseChangeBuckets("Fixtures: /tests/fixtures/\nTests: *test* !testdata/\nDocs: docs/*.md"));
  expect(match("tests/fixtures/a.json")).toBe(0);
  expect(match("lib/tests/fixtures/a.json")).toBeUndefined();
  expect(match("lib/tests/fixtures/a_test.json")).toBe(1);
  expect(match("src/footest.ts")).toBe(1);
  expect(match("pkg/testdata/footest.ts")).toBeUndefined();
  expect(match("docs/intro.md")).toBe(2);
  expect(match("docs/guide/intro.md")).toBeUndefined();
});

test("totals put unmatched files in the main work", () => {
  const totals = bucketTotals(parseChangeBuckets("Tests: *.test.*\nEvals: evals/"), [
    { path: "src/a.ts", additions: 100, deletions: 50 },
    { path: "src/b.ts", additions: 22, deletions: 30 },
    { path: "src/a.test.ts", additions: 12, deletions: 90 },
  ]);
  expect(totals.main).toEqual({ name: "Main work", files: 2, additions: 122, deletions: 80 });
  expect(totals.buckets).toEqual([{ name: "Tests", files: 1, additions: 12, deletions: 90 }, { name: "Evals", files: 0, additions: 0, deletions: 0 }]);
  expect(totals.bucketOf.get("src/a.test.ts")).toBe(0);
});
