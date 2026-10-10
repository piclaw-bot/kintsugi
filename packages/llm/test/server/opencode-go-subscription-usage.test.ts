import { expect, test } from "bun:test";
import { fetchOpenCodeGoSubscriptionUsage } from "../../src/server/opencode-go-subscription-usage.ts";

function payload() {
  return { usage: {
    rolling: { status: "ok", percent: 24, resetsAt: "2026-10-10T02:00:00Z" },
    weekly: { status: "ok", percent: 12, resetsAt: "2026-10-12T00:00:00Z" },
    monthly: { status: "ok", percent: 6, resetsAt: "2026-11-01T09:00:00Z" },
  } };
}

test("Go uses bearer API-key auth and shows only five-hour and weekly allowances", async () => {
  const usage = await fetchOpenCodeGoSubscriptionUsage("key", async (url, init) => {
    expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer key");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json(payload());
  });
  expect(usage.allowed).toBe(true);
  expect(usage.limitReached).toBe(false);
  expect(usage.plan).toBeNull();
  expect(usage.windows.map(w => [w.limitName, w.usedPercent, w.durationSeconds])).toEqual([
    ["5-hour", 24, 18000], ["Weekly", 12, 604800],
  ]);
  expect(usage.windows[0]!.resetsAt).toBe("2026-10-10T02:00:00.000Z");
});

test("Go's rate-limited status determines whether the subscription is blocked", async () => {
  const data = payload();
  data.usage.weekly.status = "rate-limited";
  const usage = await fetchOpenCodeGoSubscriptionUsage("key", async () => Response.json(data));
  expect(usage.limitReached).toBe(true);
  expect(usage.allowed).toBe(false);
});

test("Go still detects a monthly limit even though its indicator is hidden", async () => {
  const data = payload();
  data.usage.monthly.status = "rate-limited";
  const usage = await fetchOpenCodeGoSubscriptionUsage("key", async () => Response.json(data));
  expect(usage.limitReached).toBe(true);
  expect(usage.allowed).toBe(false);
  expect(usage.windows.map(window => window.limitName)).toEqual(["5-hour", "Weekly"]);
});

test("Go authentication, entitlement, network and service failures are readable", async () => {
  for (const [status, message] of [[401, "Reconnect OpenCode Go"], [403, "doesn’t have an OpenCode Go subscription"], [429, "HTTP 429"], [500, "HTTP 500"]] as const) {
    await expect(fetchOpenCodeGoSubscriptionUsage("key", async () => new Response("", { status }))).rejects.toThrow(message);
  }
  await expect(fetchOpenCodeGoSubscriptionUsage("key", async () => { throw new Error("offline"); })).rejects.toThrow("Could not reach OpenCode Go");
});

test("Go rejects malformed payloads, invalid dates, percentages and unknown status", async () => {
  await expect(fetchOpenCodeGoSubscriptionUsage("key", async () => new Response("not json"))).rejects.toThrow("invalid usage response");
  for (const change of [
    (data: ReturnType<typeof payload>) => { data.usage.rolling.resetsAt = "bad date"; },
    (data: ReturnType<typeof payload>) => { data.usage.rolling.percent = 101; },
    (data: ReturnType<typeof payload>) => { data.usage.weekly.status = "other"; },
  ]) {
    const data = payload();
    change(data);
    await expect(fetchOpenCodeGoSubscriptionUsage("key", async () => Response.json(data))).rejects.toThrow("unrecognized usage response");
  }
  await expect(fetchOpenCodeGoSubscriptionUsage("key", async () => Response.json({ usage: {} }))).rejects.toThrow("unrecognized usage response");
});
