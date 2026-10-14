// Adapted from upstream's ancestry-filtered release history for Kintsugi's version tags.
import { Type, type TSchema, type Static } from "typebox";
import { Value } from "typebox/value";
import { githubRepository } from "@kintsugi/shared/publishing";
import type { HttpFetcher } from "./registry.ts";

const revisionSchema = Type.String({ pattern: "^[a-f0-9]{40}$" });
const comparisonSchema = Type.Object({ commits: Type.Array(Type.Object({ sha: revisionSchema })), status: Type.Union([Type.Literal("ahead"), Type.Literal("behind"), Type.Literal("identical"), Type.Literal("diverged")]) });
const releaseSchema = Type.Object({ tag_name: Type.String(), body: Type.Union([Type.String({ maxLength: 1_000_000 }), Type.Null()]), draft: Type.Boolean(), prerelease: Type.Boolean(), published_at: Type.Union([Type.String(), Type.Null()]) });
const repositorySchema = Type.String({ pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}$" });
export function parseNotesRepository(value: string): string {
  const repository = value.trim();
  if (!Value.Check(repositorySchema, repository) || [".", ".."].includes(repository.split("/")[1]!)) throw new Error("Use a GitHub repository in owner/name form.");
  return repository;
}
/** OCI source labels are untrusted URLs; never fetch them or send credentials to their host. */
export function imageNotesRepository(source: string | undefined): string | undefined {
  if (!source) return undefined;
  let url: URL;
  try { url = new URL(source); } catch { return undefined; }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return undefined;
  const path = url.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "");
  if (!Value.Check(repositorySchema, path) || [".", ".."].includes(path.split("/")[1]!)) return undefined;
  return path;
}
/** Upstream publication trailers are metadata, not human notes or update authority. */
export function publishedReleaseNotes(body: string): string {
  return body.replace(/\n+<!-- (?:agents-in-the-cloud-release|kintsugi-release) \{[^\r\n]*\} -->\s*$/, "").trim();
}
export interface PublishedRelease { tag: string; revision: string; notes: string; publishedAt: string; url: string }
export interface ReleaseHistory { releases: PublishedRelease[]; targetHasNotes: boolean; compareUrl: string }

/** Published version releases crossed by this exact app revision range. No drafts or unrelated branches. */
export async function fetchReleaseHistory(current: string, target: string, fetcher: HttpFetcher = fetch, options: { repository?: string; token?: string } = {}): Promise<ReleaseHistory> {
  Value.Assert(revisionSchema, current);
  Value.Assert(revisionSchema, target);
  const repository = parseNotesRepository(options.repository ?? githubRepository);
  const base = `https://api.github.com/repos/${repository}`;
  async function get<T extends TSchema>(path: string, schema: T): Promise<Static<T>> {
    const headers = new Headers({ accept: "application/vnd.github+json" });
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    const response = await fetcher(`${base}/${path}`, { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) throw new Error(`Could not load release history (GitHub ${response.status})`);
    return Value.Parse(schema, await response.json());
  }
  async function pages<T>(load: (page: number) => Promise<T[]>): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const entries = await load(page);
      result.push(...entries);
      if (entries.length < 100) return result;
    }
    throw new Error("Release history exceeds the pagination limit");
  }
  const commits = await pages(async page => {
    const comparison = await get(`compare/${current}...${target}?per_page=100&page=${page}`, comparisonSchema);
    if (comparison.status !== "ahead" && comparison.status !== "identical") throw new Error("This target is older or on a different branch. Release notes cannot be shown as changes since your installation.");
    return comparison.commits;
  });
  const crossed = new Set(commits.map(commit => commit.sha));
  const releases: PublishedRelease[] = [];
  let targetHasNotes = false;
  const entries = await pages(page => get(`releases?per_page=100&page=${page}`, Type.Array(releaseSchema)));
  for (const entry of entries) {
    if (entry.draft || entry.prerelease || !entry.tag_name) continue;
    if (!entry.published_at) throw new Error("Published release is missing its publication date");
    // target_commitish may be a moving branch. Resolve the published tag, including annotated tags.
    const { sha } = await get(`commits/${encodeURIComponent(`refs/tags/${entry.tag_name}`)}`, Type.Object({ sha: revisionSchema }));
    const notes = publishedReleaseNotes(entry.body ?? "");
    if (sha === target && notes) targetHasNotes = true;
    if (crossed.has(sha) && notes) releases.push({ tag: entry.tag_name, revision: sha, notes, publishedAt: entry.published_at, url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(entry.tag_name)}` });
  }
  releases.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { releases, targetHasNotes, compareUrl: `https://github.com/${repository}/compare/${current}...${target}` };
}
