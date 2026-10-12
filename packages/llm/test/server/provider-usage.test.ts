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
      readGitHubCopilotUsageToken: async () => "fixture-oauth",
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
