import { createHash } from "node:crypto";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { autocompleteHtml } from "@kintsugi/design-system/autocomplete";
import { discoverGitHubToken } from "@kintsugi/proxy-egress";
import { escapeHtml } from "@kintsugi/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";

const githubRepositorySearchResponseSchema = Type.Object({
  items: Type.Array(Type.Object({
    full_name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    private: Type.Boolean(),
    clone_url: Type.String(),
  })),
});

const searchCache = new Map<string, { expiresAt: number; results: GitHubRepositorySearchResults }>();
const searchCacheMs = 60_000;

export class GitHubRepositorySearchRateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "GitHubRepositorySearchRateLimitError";
  }
}

export interface GitHubRepositorySearchResult {
  fullName: string;
  description: string | null;
  private: boolean;
  cloneUrl: string;
  personal: boolean;
}

export interface GitHubRepositorySearchResults {
  repositories: GitHubRepositorySearchResult[];
  personalSearchNotice?: string;
}

class GitHubApiError extends Error {}

function credentialKey(token: string | undefined): string {
  return token ? createHash("sha256").update(token).digest("hex") : "public";
}

const ownerCache = new Map<string, { expiresAt: number; owners: string[] }>();

async function repositoryOwners(token: string): Promise<string[]> {
  const key = credentialKey(token);
  const cached = ownerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.owners;
  const userSchema = Type.Object({ login: Type.String() });
  const user = Value.Parse(userSchema, await (await fetchGitHub(new URL("https://api.github.com/user"), token)).json());
  const owners = [user.login];
  for (let page = 1; ; page++) {
    const url = new URL("https://api.github.com/user/orgs");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const orgs = Value.Parse(Type.Array(userSchema), await (await fetchGitHub(url, token)).json());
    owners.push(...orgs.map((org) => org.login));
    if (orgs.length < 100) break;
  }
  for (const [cacheKey, entry] of ownerCache) if (entry.expiresAt <= Date.now()) ownerCache.delete(cacheKey);
  ownerCache.set(key, { expiresAt: Date.now() + searchCacheMs, owners });
  return owners;
}

async function searchGitHubRepositoryPage(query: string, token: string | undefined, personal = false): Promise<GitHubRepositorySearchResult[]> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "25");

  const response = await fetchGitHub(url, token);
  const body = Value.Parse(githubRepositorySearchResponseSchema, await response.json());
  return body.items.map((repo) => ({
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    cloneUrl: repo.clone_url,
    personal,
  }));
}

async function fetchGitHub(url: URL, token: string | undefined): Promise<Response> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const message = await response.text();
    if (response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)))) throw new GitHubRepositorySearchRateLimitError(`GitHub repository search failed: ${response.status} ${message}`, Number(response.headers.get("retry-after") ?? undefined) || undefined);
    throw new GitHubApiError(`GitHub repository search failed: ${response.status} ${message}`);
  }

  return response;
}

async function searchPersonalRepositories(query: string, token: string | undefined): Promise<GitHubRepositorySearchResults> {
  if (!token) return { repositories: [], personalSearchNotice: "Connect GitHub to search your personal and organization repositories." };
  try {
    const owners = await repositoryOwners(token);
    const repositories = await searchGitHubRepositoryPage(`${query} ${owners.map((owner) => `user:${owner}`).join(" ")}`, token, true);
    return { repositories };
  } catch (error) {
    if (error instanceof GitHubRepositorySearchRateLimitError) return { repositories: [], personalSearchNotice: "Your repositories could not be searched: GitHub is rate limited. Try again shortly." };
    if (error instanceof GitHubApiError) return { repositories: [], personalSearchNotice: "Your repositories could not be searched. Check your GitHub connection and organization access." };
    throw error;
  }
}

export async function searchGitHubRepositories(query: string): Promise<GitHubRepositorySearchResults> {
  const now = Date.now();
  for (const [key, entry] of searchCache) {
    if (entry.expiresAt <= now) searchCache.delete(key);
  }

  const token = discoverGitHubToken();
  const normalized = query.trim().toLowerCase();
  const cacheKey = `${credentialKey(token)}:${normalized}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached.results;

  const [publicRepositories, personal] = await Promise.all([
    searchGitHubRepositoryPage(`${query.trim()} is:public`, token),
    searchPersonalRepositories(query.trim(), token),
  ]);
  const seen = new Set<string>();
  const repositories = [...personal.repositories, ...publicRepositories].filter((repo) => {
    const key = repo.fullName.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const results: GitHubRepositorySearchResults = { repositories, personalSearchNotice: personal.personalSearchNotice };
  searchCache.set(cacheKey, { expiresAt: Date.now() + searchCacheMs, results });
  return results;
}

export function renderGitHubRepositorySearchRateLimitMenu(error: GitHubRepositorySearchRateLimitError): string {
  const wait = error.retryAfterSeconds ? ` Try again in ${error.retryAfterSeconds} seconds.` : " Try again in a few minutes.";
  return autocompleteHtml({ kind: "message", content: { kind: "text", text: `GitHub search is rate limited.${wait}` } });
}

export function renderGitHubRepositorySearchMenu(results: GitHubRepositorySearchResults): string {
  const notice = results.personalSearchNotice ? autocompleteHtml({ kind: "message", role: "status", content: { kind: "text", text: results.personalSearchNotice } }) : "";
  if (results.repositories.length === 0) return notice + autocompleteHtml({ kind: "message", content: { kind: "text", text: "No GitHub repositories" } });
  const groups = [
    { label: "Your repositories", repositories: results.repositories.filter((repo) => repo.personal) },
    { label: "Public repositories", repositories: results.repositories.filter((repo) => !repo.personal) },
  ];
  return notice + groups.filter((group) => group.repositories.length > 0).map((group) => {
    const heading = `<div class="workspace-template-github-heading">${escapeHtml(group.label)}</div>`;
    return heading + autocompleteHtml({ kind: "results", label: group.label, contentHtml: group.repositories.map((repo) => {
      const title = [repo.fullName, repo.description, repo.private ? "Private repository" : undefined].filter(Boolean).join(" — ");
      return contentRowHtml({
        width: "fill",
        kind: "compact",
        label: { kind: "text", text: repo.fullName },
        trailingHtml: repo.private ? "<span>Private</span>" : undefined,
        element: {
          tag: "button",
          attributesHtml: `type="button" role="option" aria-selected="false" data-git-url="${escapeHtml(repo.cloneUrl)}" title="${escapeHtml(title)}"`,
        },
      });
    }).join("") });
  }).join("");
}
