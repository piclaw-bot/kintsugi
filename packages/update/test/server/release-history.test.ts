import { expect, test } from "bun:test";
import { fetchReleaseHistory, parseNotesRepository, imageNotesRepository, publishedReleaseNotes } from "../../src/server/release-history.ts";
const sha = (n: number) => n.toString(16).padStart(40, "0");
const entry = (n: number) => ({ tag_name: `v0.1.${n}`, body: `# Version ${n}\n\n- A change.`, draft: false, prerelease: false, published_at: `2026-08-${String(n).padStart(2, "0")}T12:00:00Z`, target_commitish: "main" });
function fixture(entries = [entry(1), entry(2), entry(3), entry(4)]) {
  return async (input: string | URL) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://api.github.com");
    expect(url.pathname).toStartWith("/repos/rcarmo/kintsugi/");
    if (url.pathname.endsWith("/releases")) return Response.json(url.searchParams.get("page") === "1" ? entries : []);
    if (decodeURIComponent(url.pathname).endsWith("/refs/tags/unrelated")) return Response.json({sha:sha(999)});
    if (decodeURIComponent(url.pathname).endsWith("/refs/tags/stable")) return Response.json({sha:sha(9)});
    if (url.pathname.includes("/commits/")) return Response.json({ sha: sha(Number(url.pathname.split(".").at(-1))) });
    const match = url.pathname.match(/compare\/([a-f0-9]+)\.\.\.([a-f0-9]+)$/)!;
    const left = parseInt(match[1]!, 16), right = parseInt(match[2]!, 16);
    const start = left + 1 + (Number(url.searchParams.get("page")) - 1) * 100;
    return Response.json({ status: left === right ? "identical" : left < right ? "ahead" : "behind", commits: Array.from({ length: Math.max(0, Math.min(100, right - start + 1)) }, (_, i) => ({ sha: sha(start + i) })) });
  };
}
test("version releases are resolved by tag and filtered to crossed ancestry, newest first", async () => {
  const result = await fetchReleaseHistory(sha(1), sha(3), fixture());
  expect(result.releases.map(release => release.tag)).toEqual(["v0.1.3", "v0.1.2"]);
  expect(result.targetHasNotes).toBe(true);
  expect(result.compareUrl).toEndWith(`${sha(1)}...${sha(3)}`);
});
test("latest excludes drafts, prereleases, empty notes and unrelated tags", async () => {
  const result = await fetchReleaseHistory(sha(1), sha(6), fixture([entry(2), { ...entry(3), draft: true }, { ...entry(4), prerelease: true }, { ...entry(5), tag_name: "stable" }, { ...entry(6), body: "" }]));
  expect(result.releases.map(release => release.tag)).toEqual(["v0.1.2"]);
  expect(result.targetHasNotes).toBe(false);
});
test("comparison and release lists paginate without dropping older milestones", async () => {
  const base = fixture([entry(301)]);
  const comparisonPages: number[] = [];
  const releasePages: number[] = [];
  const result = await fetchReleaseHistory(sha(1), sha(301), async (input, init) => {
    const url = new URL(input);
    const page = Number(url.searchParams.get("page"));
    if (url.pathname.includes("/compare/")) comparisonPages.push(page);
    if (url.pathname.endsWith("/releases")) {
      releasePages.push(page);
      return Response.json(page === 1 ? Array.from({ length: 100 }, () => ({ ...entry(2), tag_name: "unrelated" })) : [entry(301)]);
    }
    return base(input);
  });
  expect(comparisonPages).toEqual([1, 2, 3, 4]);
  expect(releasePages).toEqual([1, 2]);
  expect(result.releases.map(release => release.revision)).toEqual([sha(301)]);
});
test("downgrades, divergence, malformed revisions and GitHub failures are explicit", async () => {
  await expect(fetchReleaseHistory(sha(3), sha(1), fixture())).rejects.toThrow("older");
  await expect(fetchReleaseHistory(sha(1), sha(3), async () => Response.json({ status: "diverged", commits: [] }))).rejects.toThrow("different branch");
  await expect(fetchReleaseHistory("invalid", sha(3), fixture())).rejects.toThrow();
  await expect(fetchReleaseHistory(sha(1), sha(3), async () => new Response("", { status: 403 }))).rejects.toThrow("GitHub 403");
  await expect(fetchReleaseHistory(sha(1), sha(3), async () => Response.json({ status: "ahead", commits: [{ sha: "invalid" }] }))).rejects.toThrow();
});

test("custom GitHub repositories support non-semver tags and keep auth on the fixed API host", async () => {
  const result = await fetchReleaseHistory(sha(1), sha(2), async (input, init) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://api.github.com"); expect(url.pathname).toStartWith("/repos/example/custom/");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-secret");
    expect(init?.redirect).toBe("error");
    if(url.pathname.endsWith("/releases"))return Response.json([{...entry(2),tag_name:"stable-2026-10-release"}]);
    if(url.pathname.includes("/commits/"))return Response.json({sha:sha(2)});
    return Response.json({status:"ahead",commits:[{sha:sha(2)}]});
  }, {repository:"example/custom",token:"fixture-secret"});
  expect(result.releases[0]?.tag).toBe("stable-2026-10-release");
  expect(result.releases[0]?.url).toContain("github.com/example/custom/");
  expect(result.compareUrl).toContain("github.com/example/custom/");
});
test("notes repository parsing rejects foreign URLs, credentials, traversal and extra paths", () => {
  expect(parseNotesRepository(" example/custom ")).toBe("example/custom");
  expect(imageNotesRepository("https://github.com/Example/custom.git")).toBe("Example/custom");
  for(const value of ["https://github.com/example/custom","../repo","example/..","example/custom/tree/main","user@host/repo"]) expect(()=>parseNotesRepository(value)).toThrow();
  for(const value of ["https://evil.example/example/custom","http://github.com/example/custom","https://secret@github.com/example/custom","https://github.com/example/custom?token=secret","https://github.com/example/custom/tree/main"])expect(imageNotesRepository(value)).toBeUndefined();
});

test("upstream stable publication metadata is hidden without requiring its notes format", () => {
  const body = '# Human notes\n\n- A benefit.\n\n<!-- agents-in-the-cloud-release {"revision":"abc","digest":"sha256:metadata"} -->\n';
  expect(publishedReleaseNotes(body)).toBe('# Human notes\n\n- A benefit.');
  expect(publishedReleaseNotes('# Plain GitHub release\n')).toBe('# Plain GitHub release');
  expect(publishedReleaseNotes('# Notes\n\n<!-- another-publisher {"x":1} -->')).toContain('another-publisher');
});
test("published tag resolution cannot accidentally select a same-named branch", async () => {
  const base=fixture([entry(2)]);let requested=false;
  await fetchReleaseHistory(sha(1),sha(2),async(input,init)=>{
    const url=new URL(input);
    if(url.pathname.includes('/commits/')){expect(decodeURIComponent(url.pathname)).toEndWith('/commits/refs/tags/v0.1.2');requested=true;}
    return base(input);
  });
  expect(requested).toBe(true);
});
