import { expect, test } from "bun:test";
import { changesCommitUrl, parseCommitLinkHref, parseCommitLinkSpec } from "../src/commit-target.ts";

test("commit links name a snapshot or a git-style range of two", () => {
  expect(parseCommitLinkHref("kintsugi://commit/A1B2C3D")).toEqual({ target: "a1b2c3d" });
  expect(parseCommitLinkHref("kintsugi://commit/a1b2c3d%5E..e4f5a6b")).toEqual({ base: "a1b2c3d^", target: "e4f5a6b" });
  expect(parseCommitLinkHref("kintsugi://commit/staged..working")).toEqual({ base: "staged", target: "working" });
  expect(parseCommitLinkHref("kintsugi://commit/a1b2c3d..working")).toEqual({ base: "a1b2c3d", target: "working" });
});

test("refs, moving expressions and malformed ranges are not commit links", () => {
  for (const spec of ["", "main", "HEAD", "a1b2c3", "a1b2c3d..", "a1b2c3d...e4f5a6b", "a1b2c3d..e4f5a6b..f0f0f0f", "working..working", "a1b2c3d~2", "a1b2c3d^^", "a".repeat(41)]) {
    expect(parseCommitLinkSpec(spec)).toBeUndefined();
  }
  expect(parseCommitLinkHref("kintsugi://file/work/a1b2c3d")).toBeUndefined();
});

test("opening a commit link carries the range to the Changes endpoint", () => {
  const url = new URL(changesCommitUrl("work 1", "open", { base: "a1b2c3d^", target: "working" }), "http://localhost");
  expect(url.pathname).toBe("/workspaces/work%201/changes/open");
  expect(parseCommitLinkSpec(url.searchParams.get("commit")!)).toEqual({ base: "a1b2c3d^", target: "working" });
});
