import type { JsonObject } from "@kintsugi/core";
import { expect, test } from "bun:test";
import { fetchCodexSubscriptionUsage } from "../../src/server/codex-subscription-usage.ts";

const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url")}.signature`;
const window = { used_percent: 72, limit_window_seconds: 18000, reset_at: 1800000000 };
const payload = { plan_type: "plus", rate_limit: { allowed: true, limit_reached: false, primary_window: window, secondary_window: { ...window, used_percent: 0, limit_window_seconds: 604800 } } };
const fetcher = (body: JsonObject, status = 200) => (async () => Response.json(body, { status }));

test("requests account-wide usage with resolved OAuth credentials and normalizes both windows", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, (async (url, init) => {
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-123");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(payload);
  }));
  expect(usage.plan).toBe("plus");
  expect(usage.windows).toEqual([
    { limitName: "Codex", meteredFeature: null, kind: "primary", usedPercent: 72, durationSeconds: 18000, resetsAt: new Date(1800000000000).toISOString() },
    { limitName: "Codex", meteredFeature: null, kind: "secondary", usedPercent: 0, durationSeconds: 604800, resetsAt: new Date(1800000000000).toISOString() },
  ]);
  expect(usage.allowed).toBe(true);
});

test("missing limits are unknown, not zero usage", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({ plan_type: "pro", rate_limit: null }));
  expect(usage.windows).toEqual([]);
  expect(usage.allowed).toBeNull();
  expect(usage.limitReached).toBeNull();
});

test("preserves an exhausted allowance and a missing secondary window", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({ plan_type: "plus", rate_limit: { allowed: false, limit_reached: true, primary_window: { ...window, used_percent: 100 } } }));
  expect(usage.limitReached).toBe(true);
  expect(usage.windows).toHaveLength(1);
  expect(usage.windows[0]!.usedPercent).toBe(100);
});

test("rejects malformed credentials before making a request", async () => {
  for (const token of ["invalid", "a.bnVsbA.b"]) {
    await expect(fetchCodexSubscriptionUsage(token, (async () => { throw new Error("must not fetch"); }))).rejects.toThrow("Reconnect OpenAI Codex");
  }
});

test("rejects malformed upstream data rather than inventing usage", async () => {
  for (const body of [{}, { ...payload, rate_limit: { ...payload.rate_limit, primary_window: { ...window, used_percent: -1 } } }, { ...payload, rate_limit: { ...payload.rate_limit, primary_window: { ...window, reset_at: "tomorrow" } } }]) {
    await expect(fetchCodexSubscriptionUsage(token, fetcher(body))).rejects.toThrow("unrecognized usage response");
  }
});

test("HTTP errors do not leak upstream bodies or credentials", async () => {
  for (const status of [401, 403, 429, 500]) {
    await expect(fetchCodexSubscriptionUsage(token, fetcher({ secret: token }, status))).rejects.toThrow(status === 401 ? "Reconnect OpenAI Codex" : `HTTP ${status}`);
  }
});

test("reports network and JSON failures", async () => {
  await expect(fetchCodexSubscriptionUsage(token, (async () => { throw new Error("secret"); }))).rejects.toThrow("Could not reach OpenAI");
  await expect(fetchCodexSubscriptionUsage(token, (async () => new Response("not JSON")))).rejects.toThrow("invalid usage response");
});


test("keeps all reported durations and additional feature windows without assuming monthly limits", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({
    ...payload,
    additional_rate_limits: [{ limit_name: "Long context", metered_feature: "codex_long_context", rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { ...window, limit_window_seconds: 30 * 86400, used_percent: 25 },
      secondary_window: null,
    } }],
  }));
  expect(usage.windows.map((window) => window.durationSeconds)).toEqual([18000, 604800, 2592000]);
  expect(usage.windows[2]!.limitName).toBe("Long context");
  expect(usage.windows[2]!.meteredFeature).toBe("codex_long_context");
});


test("includes code-review windows when OpenAI reports them", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({
    plan_type: "pro", rate_limit: null,
    code_review_rate_limit: { allowed: true, limit_reached: false, primary_window: { ...window, limit_window_seconds: 604800 } },
    additional_rate_limits: null,
  }));
  expect(usage.windows).toHaveLength(1);
  expect(usage.windows[0]!.limitName).toBe("Code review");
  expect(usage.windows[0]!.meteredFeature).toBe("code_review");
});

test("normalizes account details and a weekly-only allowance without leaking identity", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({
    plan_type: "pro", user_id: "private-user", account_id: "private-account", email: "private@example.com",
    rate_limit: { allowed: true, limit_reached: false, primary_window: { ...window, used_percent: 8, limit_window_seconds: 604800 }, secondary_window: null },
    credits: { has_credits: true, unlimited: false, balance: "87295.0551000000", overage_limit_reached: false },
    rate_limit_reset_credits: { available_count: 4, applicable_available_count: 0 },
    chatpass: { windows: [{ ...window, used_percent: 0, limit_window_seconds: 604800 }] },
    model_usage: { "example-model": { available: true, available_at: null, credits_would_enable: false } },
    spend_control: { reached: false, individual_limit: null },
  }));
  expect(usage.resets).toEqual({ available: 4 });
  expect(usage.credits).toEqual({ unlimited: false, balance: "87295.0551000000" });
  expect(usage.windows).toHaveLength(2);
  expect(usage.windows[1]).toEqual({ limitName: "Chatpass", meteredFeature: "chatpass", kind: "primary", usedPercent: 0, durationSeconds: 604800, resetsAt: new Date(window.reset_at * 1000).toISOString() });
  expect(JSON.stringify(usage)).not.toContain("private");
});

test("distinguishes zero resets from missing counts", async () => {
  const zero = await fetchCodexSubscriptionUsage(token, fetcher({ ...payload, rate_limit_reset_credits: { available_count: 0 } }));
  expect(zero.resets).toEqual({ available: 0 });
  const missingDetails: JsonObject[] = [{}, { credits: null, rate_limit_reset_credits: null, chatpass: null }];
  for (const extra of missingDetails) {
    const usage = await fetchCodexSubscriptionUsage(token, fetcher({ ...payload, ...extra }));
    expect(usage.resets).toBeUndefined();
    expect(usage.credits).toBeUndefined();
    expect(usage.windows).toHaveLength(2);
  }
});

test("rejects invalid reset counts and account details", async () => {
  const invalidDetails: JsonObject[] = [
    { rate_limit_reset_credits: { available_count: -1 } },
    { rate_limit_reset_credits: { available_count: 1.5 } },
    { credits: { has_credits: true, unlimited: false, balance: "lots" } },
    { chatpass: { windows: [{ ...window, used_percent: -1 }] } },
  ];
  for (const extra of invalidDetails) {
    await expect(fetchCodexSubscriptionUsage(token, fetcher({ ...payload, ...extra }))).rejects.toThrow("unrecognized usage response");
  }
});


test("subscription tokens without an account-ID claim omit the routing header", async () => {
  const accessToken = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { organization_id: "org-example" } })).toString("base64url")}.signature`;
  const usage = await fetchCodexSubscriptionUsage(accessToken, async (_url, init) => {
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.has("chatgpt-account-id")).toBe(false);
    return Response.json(payload);
  });
  expect(usage.plan).toBe("plus");
});

// Shapes below follow CodexBar's wham/usage fixtures (github.com/steipete/CodexBar).
test("numeric balances and rate limits without access flags are accepted", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({
    plan_type: "business", rate_limit: { primary_window: { ...window, used_percent: 12 } },
    credits: { has_credits: true, unlimited: false, balance: 1234 },
  }));
  expect(usage.credits).toEqual({ unlimited: false, balance: "1234" });
  expect(usage.windows[0]!.usedPercent).toBe(12);
  expect(usage.allowed).toBeNull();
});

test("workspace credit caps become a monthly window wherever OpenAI reports them", async () => {
  const reset = Date.parse("2026-07-01T00:00:00Z") / 1000;
  const bodies: JsonObject[] = [
    { plan_type: "enterprise", rate_limit: { primary_window: null, secondary_window: null, individual_limit: { limit: 100000, used: "7761", remaining_percent: 92.239, resets_at: reset } } },
    { plan_type: "business", individual_limit: { limit: 400, used: 300 } },
    { plan_type: "business", spend_control: { reached: false, individual_limit: { limit: "400", used: 300, reset_at: reset } } },
  ];
  for (const body of bodies) {
    const usage = await fetchCodexSubscriptionUsage(token, fetcher(body));
    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]).toMatchObject({ limitName: "Monthly credits", meteredFeature: "credits", periodBasis: "calendar-month-estimate" });
    expect(usage.windows[0]!.usedPercent).toBeCloseTo(body.plan_type === "enterprise" ? 7.761 : 75);
    if (body.plan_type === "enterprise" || "spend_control" in body) expect(usage.windows[0]!.durationSeconds).toBe(30 * 86400);
  }
});

test("an unfamiliar additional limit doesn't hide the main windows", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({ ...payload, additional_rate_limits: [{ limit_name: "Spark" }, { limit_name: "Long context", metered_feature: "long", rate_limit: { primary_window: window } }] }));
  expect(usage.windows.map((entry) => entry.limitName)).toEqual(["Codex", "Codex", "Long context"]);
});

test("over-limit usage is shown as exhausted", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({ ...payload, rate_limit: { primary_window: { ...window, used_percent: 104 } } }));
  expect(usage.windows[0]!.usedPercent).toBe(100);
});

test("missing plan metadata doesn't hide reported limits", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({ rate_limit: { primary_window: window } }));
  expect(usage.plan).toBeNull();
  expect(usage.windows[0]!.usedPercent).toBe(72);
});
