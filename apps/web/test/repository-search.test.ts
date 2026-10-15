import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldSearchRepositories } from "@kintsugi/shared";
import { searchRepositories } from "../src/server/repository-search.ts";

const originalFetch = globalThis.fetch;
let previousDataDir: string | undefined;
let previousToken: string | undefined;
let dataDir: string;
let requests: URL[];

beforeEach(async () => {
  previousDataDir = process.env.ATELIER_DATA_DIR;
  previousToken = process.env.GH_TOKEN;
  dataDir = await mkdtemp(join(tmpdir(), "kintsugi-repository-search-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  delete process.env.GH_TOKEN;
  requests = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.host === "api.github.com" && url.pathname === "/user") return Response.json({ login: "me" });
    if (url.host === "api.github.com" && url.pathname === "/user/orgs") return Response.json([]);
    if (url.host === "api.github.com") return Response.json({ items: [{ full_name: `octo/${url.searchParams.get("q")!.split(" ")[0]}`, description: null, private: false, clone_url: "https://github.com/octo/widget.git" }] });
    throw new Error(`unexpected fetch ${url.href}`);
  }, { preconnect: originalFetch.preconnect });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  if (previousToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = previousToken;
  await rm(dataDir, { recursive: true, force: true });
});

test("explicit provider URLs bypass search while repository names remain searchable", () => {
  expect(shouldSearchRepositories("github.com/octocat/Hello-World")).toBe(false);
  expect(shouldSearchRepositories(" GitHub.com/octocat/Hello-World.git#main ")).toBe(false);
  expect(shouldSearchRepositories("https://github.com/octocat/Hello-World")).toBe(false);
  expect(shouldSearchRepositories("Hello-World")).toBe(true);
});

test("without connections only public GitHub is searched", async () => {
  const searches = await searchRepositories("widget");
  expect(searches.map((search) => search.provider.id)).toEqual(["github"]);
  expect(requests.every((url) => url.host === "api.github.com")).toBe(true);
});

test("a rate limit becomes a notice instead of failing the search", async () => {
  globalThis.fetch = Object.assign(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "9" } }), { preconnect: originalFetch.preconnect });

  const searches = await searchRepositories("gadget");
  expect(searches[0]!.notice).toBe("GitHub search is rate limited. Try again in 9 seconds.");
});

test("results are cached per provider, credential and normalized query", async () => {
  await searchRepositories("cached");
  const count = requests.length;
  await searchRepositories(" CACHED ");
  expect(requests).toHaveLength(count);
  process.env.GH_TOKEN = "another-token";
  await searchRepositories("cached");
  expect(requests.length).toBeGreaterThan(count);
});
