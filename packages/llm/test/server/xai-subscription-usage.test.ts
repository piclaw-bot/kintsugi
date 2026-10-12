import { expect, test } from "bun:test";
import { fetchXaiSubscriptionUsage } from "../../src/server/xai-subscription-usage.ts";

function billing(creditUsagePercent: number) {
  return {
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-30T03:16:28.997216+00:00", end: "2026-10-07T03:16:28.997216+00:00" },
      creditUsagePercent,
      productUsage: [{ product: "GrokBuild", usagePercent: creditUsagePercent }],
      prepaidBalance: { val: 0 },
    },
  };
}

test("xAI's shared allowance is one window for the billing period", async () => {
  const usage = await fetchXaiSubscriptionUsage("token", async (url, init) => {
    expect(url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    return Response.json(billing(11));
  });
  expect(usage.limitReached).toBe(false);
  expect(usage.windows).toEqual([{ limitName: "Grok", meteredFeature: null, kind: "primary", usedPercent: 11, durationSeconds: 7 * 86400, resetsAt: "2026-10-07T03:16:28.997Z" }]);
});

test("a spent xAI allowance is reported as reached", async () => {
  expect((await fetchXaiSubscriptionUsage("token", async () => Response.json(billing(100)))).limitReached).toBe(true);
});

test("rejected xAI credentials ask for a reconnect", async () => {
  await expect(fetchXaiSubscriptionUsage("token", async () => new Response("", { status: 401 }))).rejects.toThrow("Reconnect xAI");
});

test("unrecognized xAI billing responses are errors", async () => {
  await expect(fetchXaiSubscriptionUsage("token", async () => Response.json({ config: {} }))).rejects.toThrow("unrecognized");
});

// Shapes below follow CodexBar's Grok billing handling (github.com/steipete/CodexBar).
test("an unused on-demand allowance is zero when proto3 omits its val", async () => {
  const { config } = billing(0);
  const usage = await fetchXaiSubscriptionUsage("token", async () => Response.json({ config: { currentPeriod: config.currentPeriod, subscriptionTier: "SuperGrok", onDemandCap: { val: 100 }, onDemandUsed: {} } }));
  expect(usage.windows[0]).toMatchObject({ usedPercent: 0, durationSeconds: 7 * 86400 });
  expect(usage.plan).toBe("SuperGrok");
  expect(usage.limitReached).toBe(false);
});

test("billing-period dates and on-demand amounts stand in for missing fields", async () => {
  const usage = await fetchXaiSubscriptionUsage("token", async () => Response.json({ config: {
    billingPeriodStart: "2026-10-01T00:00:00Z", billingPeriodEnd: "2026-11-01T00:00:00Z",
    onDemandCap: { val: "2000" }, onDemandUsed: { val: 500 },
  } }));
  expect(usage.windows[0]).toMatchObject({ usedPercent: 25, durationSeconds: 31 * 86400, resetsAt: "2026-11-01T00:00:00.000Z" });
});

test("over-limit usage is reached and preserves the reported percentage", async () => {
  const usage = await fetchXaiSubscriptionUsage("token", async () => Response.json(billing(120)));
  expect(usage.limitReached).toBe(true);
  expect(usage.windows[0]!.usedPercent).toBe(120);
});


test("billing dates alone never invent zero consumption", async () => {
  const usage = await fetchXaiSubscriptionUsage("token", async () => Response.json({ config: { currentPeriod: billing(0).config.currentPeriod } }));
  expect(usage.windows).toEqual([]);
  expect(usage.limitReached).toBeNull();
});

test("a known percentage survives absent or null billing-period metadata", async () => {
  for (const extra of [{}, { currentPeriod: null }]) {
    const usage = await fetchXaiSubscriptionUsage("token", async () => Response.json({ config: { creditUsagePercent: 13, ...extra } }));
    expect(usage.windows[0]).toMatchObject({ usedPercent: 13, resetsAt: null, durationSeconds: null });
  }
});

test("prepaid wallet values are cents, can stand alone, and don't invent monthly spend", async () => {
  for (const [wallet, expected] of [[{ val: "1234" }, 12.34], [{}, 0]] as const) {
    const usage = await fetchXaiSubscriptionUsage("token", async () => Response.json({ config: { prepaidBalance: wallet } }));
    expect(usage.balance).toEqual({ currency: "USD", available: expected, monthSpend: null });
    expect(usage.windows).toEqual([]);
    expect(usage.limitReached).toBeNull();
  }
});

test("bad optional wallets cannot hide otherwise valid allowance usage", async () => {
  for (const prepaidBalance of [{ val: "bad" }, { val: -1 }, { val: 12.34 }, { val: "9".repeat(400) }]) {
    const usage = await fetchXaiSubscriptionUsage("token", async () => Response.json({ config: { creditUsagePercent: 13, prepaidBalance } }));
    expect(usage.balance).toBeUndefined();
    expect(usage.windows[0]!.usedPercent).toBe(13);
  }
});

test("overflowing on-demand amounts cannot turn into zero consumption", async () => {
  await expect(fetchXaiSubscriptionUsage("token", async () => Response.json({ config: { onDemandCap: { val: "9".repeat(400) }, onDemandUsed: { val: 500 }, billingPeriodEnd: "2026-11-01T00:00:00Z" } }))).rejects.toThrow("unrecognized");
});

test("sub-second periods have no zero-duration pacing window", async () => {
  const usage = await fetchXaiSubscriptionUsage("token", async () => Response.json({ config: { creditUsagePercent: 13, currentPeriod: { start: "2026-10-01T00:00:00Z", end: "2026-10-01T00:00:00.100Z" } } }));
  expect(usage.windows[0]!.durationSeconds).toBeNull();
});

test("ambiguous billing timestamps and impossible dates are rejected consistently", async () => {
  for (const end of ["2026-02-30T00:00:00Z", "2026-11-01T00:00:00"]) {
    await expect(fetchXaiSubscriptionUsage("token", async () => Response.json({ config: { creditUsagePercent: 13, currentPeriod: { end } } }))).rejects.toThrow("unrecognized");
  }
});
