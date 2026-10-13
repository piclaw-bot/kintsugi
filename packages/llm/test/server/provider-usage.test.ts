import { expect, test } from "bun:test";

// Process isolation keeps runtime/fetch mocks away from other provider tests.
test("Copilot account usage does not depend on resolving its inference token", async () => {
  const runtimePath = new URL("../../src/server/pi-config-models.ts", import.meta.url).pathname;
  const usagePath = new URL("../../src/server/provider-usage.ts", import.meta.url).pathname;
  const script = `
    import { mock } from "bun:test";
    mock.module(${JSON.stringify(runtimePath)}, () => ({
      createPiModelRuntime: async () => ({
        getProviderAuthStatus: () => ({ configured: true }),
        getAuth: async () => { throw new Error("Inference authentication must not be requested"); },
      }),
      cheapestProviderModel: () => undefined,
      readGitHubCopilotUsageCredentials: async () => ({ token: "fixture-oauth" }),
    }));
    globalThis.fetch = async (url, init) => {
      if (url !== "https://api.github.com/copilot_internal/user") throw new Error("Wrong endpoint");
      if (new Headers(init.headers).get("authorization") !== "token fixture-oauth") throw new Error("Wrong credential");
      return Response.json({ quota_snapshots: { premium_interactions: { percent_remaining: 70 } } });
    };
    const { getProviderUsageOverview, supportedUsageProviders } = await import(${JSON.stringify(usagePath)});
    const result = await getProviderUsageOverview(supportedUsageProviders.find((provider) => provider.id === "github-copilot"));
    console.log(JSON.stringify({ error: result.error, used: result.windows[0]?.reported.usedPercent }));
  `;
  const proc = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ error: null, used: 30 });
});

async function usageScript(body: string) {
  const runtimePath = new URL("../../src/server/pi-config-models.ts", import.meta.url).pathname;
  const usagePath = new URL("../../src/server/provider-usage.ts", import.meta.url).pathname;
  const script = `
    import { mock } from "bun:test";
    let credential = "fixture-a";
    let enterpriseUrl;
    mock.module(${JSON.stringify(runtimePath)}, () => ({
      createPiModelRuntime: async () => ({ getProviderAuthStatus: () => ({ configured: true }), getAuth: async () => ({ auth: { apiKey: credential }, source: "OAuth" }) }),
      cheapestProviderModel: () => ({ id: "model" }),
      readGitHubCopilotUsageCredentials: async () => ({ token: credential, enterpriseUrl }),
    }));
    const { getProviderUsageOverview, supportedUsageProviders } = await import(${JSON.stringify(usagePath)});
    const provider = supportedUsageProviders.find((provider) => provider.id === "github-copilot");
    ${body}
  `;
  const proc = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return JSON.parse(stdout);
}

test("simultaneous rings/limits reads share a request, then completed snapshots are fetched fresh", async () => {
  const result = await usageScript(`
    let calls = 0;
    globalThis.fetch = async () => { calls++; await Bun.sleep(20); return Response.json({ quota_snapshots: { premium_models: { percent_remaining: 87 } } }); };
    const first = await Promise.all([getProviderUsageOverview(provider), getProviderUsageOverview(provider)]);
    const concurrentCalls = calls;
    await getProviderUsageOverview(provider);
    console.log(JSON.stringify({ concurrentCalls, calls, used: first.map((overview) => overview.windows[0].reported.usedPercent) }));
  `);
  expect(result).toEqual({ concurrentCalls: 1, calls: 2, used: [13, 13] });
});

test("pending usage never crosses changed credentials, and failed requests do not poison retries", async () => {
  const result = await usageScript(`
    let release, started;
    const gate = new Promise((resolve) => { release = resolve; });
    const ready = new Promise((resolve) => { started = resolve; });
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const firstAccount = new Headers(init.headers).get("authorization") === "token fixture-a";
      started(); await gate;
      return Response.json({ quota_snapshots: { premium_models: { percent_remaining: firstAccount ? 87 : 60 } } });
    };
    const a = getProviderUsageOverview(provider); await ready;
    credential = "fixture-b";
    const b = getProviderUsageOverview(provider); release();
    const overviews = await Promise.all([a, b]);
    globalThis.fetch = async () => new Response("private", { status: 429 });
    const failed = await getProviderUsageOverview(provider);
    globalThis.fetch = async () => Response.json({ quota_snapshots: { premium_models: { percent_remaining: 50 } } });
    const retried = await getProviderUsageOverview(provider);
    console.log(JSON.stringify({ calls, used: overviews.map((o) => o.windows[0].reported.usedPercent), error: failed.error.includes("HTTP 429"), retried: retried.windows[0].reported.usedPercent }));
  `);
  expect(result).toEqual({ calls: 2, used: [13, 40], error: true, retried: 50 });
});

test("pacing uses the current clock, not an older Claude consumption snapshot", async () => {
  const result = await usageScript(`
    const now = Date.now();
    const checkedAt = new Date(now - 86400000).toISOString();
    const adapterPath = ${JSON.stringify(new URL("../../src/server/anthropic-subscription-usage.ts", import.meta.url).pathname)};
    mock.module(adapterPath, () => ({ anthropicUsageSource: { usage: async () => ({ plan: null, checkedAt, allowed: null, limitReached: null, windows: [{ limitName: "Claude", meteredFeature: null, kind: "primary", usedPercent: 13, durationSeconds: 18000, resetsAt: new Date(now + 9000000).toISOString() }] }) } }));
    const overview = await getProviderUsageOverview(supportedUsageProviders.find((p) => p.id === "anthropic"));
    console.log(JSON.stringify({ state: overview.windows[0].timing.state, elapsed: Math.round(overview.windows[0].timing.elapsedPercent), oldSnapshot: overview.reported.checkedAt === checkedAt, currentTiming: new Date(overview.timingAt).getTime() >= now }));
  `);
  expect(result).toEqual({ state: "active", elapsed: 50, oldSnapshot: true, currentTiming: true });
});

test("an explicit refresh cannot join an ordinary cached Claude read", async () => {
  const result = await usageScript(`
    const flags = [];
    const adapterPath = ${JSON.stringify(new URL("../../src/server/anthropic-subscription-usage.ts", import.meta.url).pathname)};
    mock.module(adapterPath, () => ({ anthropicUsageSource: { usage: async (_token, options) => {
      flags.push(options.refresh); await Bun.sleep(20);
      return { plan: null, checkedAt: new Date().toISOString(), allowed: null, limitReached: null, windows: [] };
    } } }));
    const claude = supportedUsageProviders.find((p) => p.id === "anthropic");
    await Promise.all([getProviderUsageOverview(claude), getProviderUsageOverview(claude, { refresh: true })]);
    console.log(JSON.stringify(flags.sort()));
  `);
  expect(result).toEqual([false, true]);
});

test("pending Copilot usage remains isolated when the enterprise issuer changes with the same token", async () => {
  const result = await usageScript(`
    let release, started;
    const gate = new Promise((resolve) => { release = resolve; });
    const ready = new Promise((resolve) => { started = resolve; });
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url); started(); await gate;
      return Response.json({ quota_snapshots: { premium_models: { percent_remaining: url.includes("api.first.example") ? 87 : 60 } } });
    };
    enterpriseUrl = "first.example";
    const a = getProviderUsageOverview(provider); await ready;
    enterpriseUrl = "second.example";
    const b = getProviderUsageOverview(provider); release();
    const result = await Promise.all([a, b]);
    console.log(JSON.stringify({ calls, used: result.map((o) => o.windows[0].reported.usedPercent) }));
  `);
  expect(result).toEqual({ calls: ["https://api.first.example/copilot_internal/user", "https://api.second.example/copilot_internal/user"], used: [13, 40] });
});
