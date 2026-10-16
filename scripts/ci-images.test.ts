import { imageSource } from "../packages/shared/src/publishing.ts";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyImagePair, channelMatches, digestValue, publishVersion, releaseTag, sliceReferences, verifiedImage } from "./ci-images.ts";
import { systemVersion, systemVersionLabel, requiredSystemVersion, requiredSystemVersionLabel, resourcePolicyVersion, resourcePolicyVersionLabel, networkPolicyVersion, networkPolicyVersionLabel } from "../packages/shared/src/system-version.ts";
import type { Run } from "./release-support.ts";

const digest = `sha256:${"a".repeat(64)}`;
const amd64 = `sha256:${"b".repeat(64)}`;
const arm64 = `sha256:${"c".repeat(64)}`;
const image = "ghcr.io/example/kintsugi";
const workspace = `ghcr.io/example/kintsugi-workspace@${digest}`;
const label = "org.opencontainers.image.revision";
const commit = "d".repeat(40);
const manifest = () => ({ digest, manifests: [
  { digest: amd64, platform: { os: "linux", architecture: "amd64" } },
  { digest: arm64, platform: { os: "linux", architecture: "arm64" } },
] });
function runner(options: { missing?: string; modifyManifest?: (value: ReturnType<typeof manifest>) => void; modifyConfig?: (value: { os: string; architecture: string; config: { Labels: Record<string, string> } }) => void } = {}): Run {
  return async args => {
    if (options.missing) return { code: 1, stdout: "", stderr: options.missing };
    if (args.at(-1) === "{{json .Manifest}}") {
      const value = manifest(); options.modifyManifest?.(value);
      return { code: 0, stdout: JSON.stringify(value), stderr: "" };
    }
    const value = { os: "linux", architecture: args.includes(`${image}@${amd64}`) ? "amd64" : "arm64", config: { Labels: {
      [label]: commit,
      "org.opencontainers.image.source": imageSource,
      [systemVersionLabel]: String(systemVersion),
      [requiredSystemVersionLabel]: String(requiredSystemVersion),
      [networkPolicyVersionLabel]: String(networkPolicyVersion),
      [resourcePolicyVersionLabel]: String(resourcePolicyVersion),
      "eagerly-preload": JSON.stringify([workspace]),
      "com.kintsugi.workspace-image.ref": workspace,
      "com.kintsugi.system.signature": "signature",
      "kintsugi.installer-config": "1",
    } } };
    options.modifyConfig?.(value);
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  };
}

test("digest receipts reject malformed or injected values", () => {
  expect(digestValue(digest)).toBe(digest);
  for (const value of ["latest", digest + "\n--tag latest", "sha256:abc", ""]) expect(() => digestValue(value)).toThrow();
});
test("merge requires exactly one receipt per native architecture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ci-image-receipts-"));
  try {
    await writeFile(join(directory, "amd64"), amd64);
    expect(() => sliceReferences(directory, image)).toThrow();
    await writeFile(join(directory, "arm64"), arm64);
    expect(sliceReferences(directory, image)).toEqual([`${image}@${amd64}`, `${image}@${arm64}`]);
    await writeFile(join(directory, "extra"), digest);
    expect(() => sliceReferences(directory, image)).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("verified app requires both native slices and pinned multiarch dependency", async () => {
  expect(await verifiedImage(runner(), `${image}:sha-${commit}`, label, commit)).toBe(`${image}@${digest}`);
});
test("only explicit missing manifests are reusable cache misses", async () => {
  expect(await verifiedImage(runner({ missing: "manifest unknown" }), image, label, commit, true)).toBeUndefined();
  for (const missing of ["unauthorized", "denied", "connection refused", "HTTP 500"])
    await expect(verifiedImage(runner({ missing }), image, label, commit, true)).rejects.toThrow("Cannot inspect");
});
test("required manifests never accept absence", async () => {
  await expect(verifiedImage(runner({ missing: "manifest unknown" }), image, label, commit)).rejects.toThrow();
});
test("partial, duplicate and invalid manifests fail closed", async () => {
  for (const modifyManifest of [
    (value: ReturnType<typeof manifest>) => { value.manifests.pop(); },
    (value: ReturnType<typeof manifest>) => { value.manifests[1]!.platform.architecture = "amd64"; },
    (value: ReturnType<typeof manifest>) => { value.digest = "bad"; },
    (value: ReturnType<typeof manifest>) => { value.manifests[0]!.digest = "bad"; },
  ]) await expect(verifiedImage(runner({ modifyManifest }), image, label, commit, true)).rejects.toThrow();
});
test("wrong source revision cannot be reused", async () => {
  await expect(verifiedImage(runner({ modifyConfig: value => { value.config.Labels[label] = "wrong"; } }), image, label, commit, true)).rejects.toThrow("does not match");
});
test("wrong native architecture cannot pass verification", async () => {
  await expect(verifiedImage(runner({ modifyConfig: value => { value.architecture = "arm64"; } }), image, label, commit)).rejects.toThrow("does not match");
});
test("mutable or inconsistent workspace dependencies fail", async () => {
  for (const dependency of ["ghcr.io/example/workspace:latest", `${image}@${digest}`])
    await expect(verifiedImage(runner({ modifyConfig: value => { value.config.Labels["eagerly-preload"] = JSON.stringify([dependency]); } }), image, label, commit)).rejects.toThrow();
});
test("current channels skip promotion only after a verified digest match", async () => {
  expect(await channelMatches(runner(), `${image}@${digest}`)).toBe(true);
  expect(await channelMatches(runner(), `${image}@${amd64}`)).toBe(false);
  expect(await channelMatches(runner({ missing: "manifest unknown" }), `${image}@${digest}`)).toBe(false);
  await expect(channelMatches(runner({ missing: "unauthorized" }), `${image}@${digest}`)).rejects.toThrow();
  await expect(channelMatches(runner(), `${image}:latest`)).rejects.toThrow();
});

test("System reuse requires the installer capability", async () => {
  await expect(verifiedImage(runner({ modifyConfig: value => { value.config.Labels["kintsugi.installer-config"] = "0"; } }), image, "com.kintsugi.system.signature", "signature")).rejects.toThrow("installer capability");
});

test("release versions are strict stable semantic versions", () => {
  for (const tag of ["v0.0.1", "v1.2.3", "v10.20.30"]) expect(releaseTag(tag)).toBe(tag);
  for (const tag of ["latest", "v01.0.1", "v1.2", "v1.2.3-rc.1", "v1.2.3\n", "v1.2.3; echo secret"]) expect(() => releaseTag(tag)).toThrow();
});
test("release publication reuses matching versions and rejects overwrites", async () => {
  await publishVersion(runner(), image + "@" + digest, "v0.0.1");
  await expect(publishVersion(runner(), image + "@" + amd64, "v0.0.1")).rejects.toThrow("immutable release tag");
});
test("version preflight never publishes and registry errors fail closed", async () => {
  const calls: string[][] = [];
  const missing: Run = async args => { calls.push(args); return {code: 1, stdout: "", stderr: "manifest unknown"}; };
  await publishVersion(missing, image + "@" + digest, "v0.0.1", true);
  expect(calls).toHaveLength(1);
  await expect(publishVersion(runner({missing: "unauthorized"}), image + "@" + digest, "v0.0.1")).rejects.toThrow();
});
test("new version is checked after publication", async () => {
  let published = false;
  const base = runner();
  const run: Run = async (args, options) => {
    if (args.includes("create")) {published = true; return {code: 0, stdout: "", stderr: ""};}
    if (!published) return {code: 1, stdout: "", stderr: "manifest unknown"};
    return base(args, options);
  };
  await publishVersion(run, image + "@" + digest, "v0.0.1");
  expect(published).toBe(true);
  published = false;
  await expect(publishVersion(run, image + "@" + amd64, "v0.0.1")).rejects.toThrow("published digest mismatch");
});

test("only version tags start release CI and publication has no manual bypass", () => {
  const release = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  const images = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/images.yml", import.meta.url), "utf8"));
  expect(Object.keys(release.on)).toEqual(["push"]);
  expect(release.on.push.tags).toEqual(["v*.*.*"]);
  expect(Object.keys(images.on)).toEqual(["workflow_call"]);
  expect(release.jobs.checks.needs).toBe("validate");
  expect(release.jobs.images.needs).toBe("checks");
  expect(release.jobs.release.needs).toBe("images");
  expect(release.jobs.images.with.publish).toBe(true);
  expect(release.concurrency["cancel-in-progress"]).toBe(false);
});
test("ordinary pushes never trigger CI; PR/manual checks and tag gates remain", () => {
  const ci = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  for (const event of [ci.on.pull_request]) {
    expect(event["paths-ignore"]).toContain("docs/**");
    expect(event["paths-ignore"]).toContain(".github/**");
    expect(event["paths-ignore"]).toContain("**/*.md");
  }
  expect(ci.on).not.toHaveProperty("push");
  expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "workflow_call", "workflow_dispatch"]);
  expect(ci.on).toHaveProperty("workflow_call");
  const selection = ci.jobs.check.steps.find((step: { id?: string; run: string }) => step.id === "changes").run;
  expect(selection).toContain("'${{ github.ref_type }}' != tag");
  expect(selection).toContain("required=true");
});

test("Caddy recipe keeps UI, preview and API origins separate without rewriting security headers",async()=>{
 const {caddyRecipe}=await import("./deployment.ts");
 const recipe=caddyRecipe("https://agent-host.local","127.0.0.1:3000","41000:41001","192.0.2.10","https://agent-host.local:3443","127.0.0.1:3444");
 expect(recipe).toContain("https://agent-host.local:41000");expect(recipe).toContain("https://agent-host.local:41001");expect(recipe).toContain("flush_interval -1");
 expect(recipe).not.toContain("header_up Origin");expect(recipe).not.toContain("header_up Authorization");expect(recipe).not.toContain("header_up Host");
 expect(()=>caddyRecipe("https://agent-host.local","192.0.2.10:3000","41000:41001","192.0.2.10")).toThrow("loopback");
});

function pairRunner(required: readonly (string | undefined)[], available: readonly (string | undefined)[]): Run {
  return async args => {
    if (args.at(-1) === "{{json .Manifest}}") return { code: 0, stdout: JSON.stringify(manifest()), stderr: "" };
    const ref = args[4]!;
    const index = ref.endsWith(amd64) ? 0 : 1;
    const labels: Record<string, string> = {};
    const value = ref.startsWith(image + "-system") ? available[index] : required[index];
    if (value !== undefined) labels[ref.startsWith(image + "-system") ? systemVersionLabel : requiredSystemVersionLabel] = value;
    return { code: 0, stdout: JSON.stringify({ os: "linux", architecture: index === 0 ? "amd64" : "arm64", config: { Labels: labels } }), stderr: "" };
  };
}

test("candidate pairs validate both native architectures, including legacy version-zero images", async () => {
  await verifyImagePair(pairRunner([undefined, undefined], [undefined, undefined]), image + "@" + digest, image + "-system@" + digest);
  await verifyImagePair(pairRunner(["1", "1"], ["2", "2"]), image + "@" + digest, image + "-system@" + digest);
  await expect(verifyImagePair(pairRunner(["2", "2"], ["1", "1"]), image + "@" + digest, image + "-system@" + digest)).rejects.toThrow("needs installation compatibility version 2");
  await expect(verifyImagePair(pairRunner(["0", "1"], ["2", "2"]), image + "@" + digest, image + "-system@" + digest)).rejects.toThrow("disagree");
  await expect(verifyImagePair(pairRunner(["0", "0"], ["1", "2"]), image + "@" + digest, image + "-system@" + digest)).rejects.toThrow("disagree");
});

test("reusable images must carry compatibility labels matching the current source", async () => {
  await expect(verifiedImage(runner({ modifyConfig: value => { delete value.config.Labels[systemVersionLabel]; } }), image, "com.kintsugi.system.signature", "signature")).rejects.toThrow("System compatibility label");
  await expect(verifiedImage(runner({ modifyConfig: value => { value.config.Labels[requiredSystemVersionLabel] = "999"; } }), image, label, commit)).rejects.toThrow("app compatibility label");
});

test("release checks pair compatibility before publishing and advances services before the app", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/images.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.promote.steps;
  const pairIndex = steps.findIndex((step: { run?: string }) => step.run?.includes("ci-images.ts pair"));
  const publishIndex = steps.findIndex((step: { run?: string }) => step.run?.includes("ci-images.ts release \"$ref\""));
  expect(pairIndex).toBeGreaterThan(-1);
  expect(pairIndex).toBeLessThan(publishIndex);
  expect(steps[publishIndex].run).toContain("for kind in workspace system app");
  expect(workflow.jobs.system.steps.find((step: { id?: string }) => step.id === "system").with.labels).toContain("system_compatibility");
  expect(workflow.jobs.images.steps.find((step: { id?: string }) => step.id === "app").with.labels).toContain("app_compatibility");
});

test("manifest reuse refuses absent or foreign source attribution", async () => {
  for (const source of [undefined, "https://github.com/another/fork"]) {
    await expect(verifiedImage(runner({modifyConfig:value=>{if(source===undefined)delete value.config.Labels["org.opencontainers.image.source"];else value.config.Labels["org.opencontainers.image.source"]=source;}}),image,label,commit)).rejects.toThrow("source label");
  }
});
test("every native image workflow takes source attribution from publishing configuration", () => {
  const workflow=Bun.YAML.parse(readFileSync(new URL("../.github/workflows/images.yml",import.meta.url),"utf8"));
  for(const [job,id] of [["workspace","build"],["system","system"],["images","app"]]){
    const step=workflow.jobs[job].steps.find((step:{id?:string})=>step.id===id);
    expect(step.with.labels).toContain("needs.prepare.outputs.image_source");
  }
});

test("Caddy avoids Tailscale UDP 41641 with an exact listener override and retains its TCP preview", async () => {
  const { caddyRecipe } = await import("./deployment.ts");
  const recipe = caddyRecipe("https://host.local", "127.0.0.1:3000", "41000:41999", "192.0.2.10,2001:db8::10");
  expect(recipe).toContain("servers 192.0.2.10:41641 {\n        protocols h1 h2");
  expect(recipe).toContain("servers [2001:db8::10]:41641 {\n        protocols h1 h2");
  expect(recipe).toContain("https://host.local:41641");
  expect(recipe).not.toContain("servers {");
  for (const [origin, range] of [["https://host.local", "41000:41009"], ["http://host.local", "41000:41999"]]) {
    expect(caddyRecipe(origin!, "127.0.0.1:3000", range!, "192.0.2.10")).not.toContain("protocols h1 h2");
  }
});

test("default Caddy generation covers the full retained preview pool", async()=>{
  const child=Bun.spawn([process.execPath,"scripts/deployment.ts","caddyfile","--origin","https://host.local","--bind","192.0.2.10"],{stdout:"pipe",stderr:"pipe",env:{...process.env}});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code).toBe(0);expect(err).toBe("");expect(out).toContain("https://host.local:41000");expect(out).toContain("https://host.local:41009");expect(out).toContain("https://host.local:41999");expect(out).not.toContain("https://host.local:42000");
});
