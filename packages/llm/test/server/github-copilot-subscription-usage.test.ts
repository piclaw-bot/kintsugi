import { expect, test, setSystemTime } from "bun:test";
import { fetchGitHubCopilotSubscriptionUsage } from "../../src/server/github-copilot-subscription-usage.ts";
import { usageWindowTiming, selectPacingWindow, estimatedTimeToHitLimitSeconds } from "../../src/server/usage-window.ts";

function payload() {
  return { copilot_plan: "individual", token_based_billing: false, quota_reset_date: "2026-11-01", quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 210, percent_remaining: 70 },
    chat: { entitlement: 500, remaining: 400 },
  } };
}

test("reads Copilot quotas using GitHub's token and editor headers", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("github-oauth", async (url, init) => {
    expect(url).toBe("https://api.github.com/copilot_internal/user");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("token github-oauth");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("editor-version")).toBe("vscode/1.96.2");
    expect(headers.get("editor-plugin-version")).toBe("copilot-chat/0.26.7");
    expect(headers.get("user-agent")).toBe("GitHubCopilotChat/0.26.7");
    expect(headers.get("x-github-api-version")).toBe("2025-04-01");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json(payload());
  });
  expect(usage.plan).toBe("individual");
  expect(usage.limitReached).toBeNull();
  expect(usage.windows).toEqual([
    { periodBasis: "calendar-month-estimate", limitName: "Premium requests", meteredFeature: "premium_interactions", kind: "primary", usedPercent: 30, durationSeconds: 31 * 86400, resetsAt: "2026-11-01T00:00:00.000Z" },
  ]);
  expect(usage.allowances?.find((allowance) => allowance.quotaId === "chat")?.remainingPercent).toBe(80);
  const windows = usage.windows.map(reported => ({ reported, timing: usageWindowTiming(reported, new Date("2026-10-16T12:00:00Z")) }));
  expect(windows[0]!.timing).toEqual({ state: "active", startsAt: "2026-10-01T00:00:00.000Z", elapsedPercent: 50, paceDifferencePoints: -20, paceDifferenceSeconds: -0.2 * 31 * 86400 });
  expect(selectPacingWindow(windows)).toBe(windows[0]);
});

test("prefers percent_remaining over entitlement arithmetic", async () => {
  const data = payload();
  data.quota_snapshots.premium_interactions.remaining = 100;
  expect((await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json(data))).windows[0]!.usedPercent).toBe(30);
});

test("unlimited chat is preserved without a pacing window and exhaustion is separate from access", async () => {
  const data = payload();
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...data, quota_snapshots: {
    premium_interactions: { percent_remaining: 0 }, chat: { unlimited: true, entitlement: 0 },
  } }));
  expect(usage.windows).toHaveLength(1);
  expect(usage.limitReached).toBeNull();
  expect(usage.allowances?.find((allowance) => allowance.selected)?.remainingPercent).toBe(0);
});

test("missing reset timing retains quotas without inventing pacing", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_snapshots: { premium_interactions: { percent_remaining: 40 } } }));
  expect(usage.windows[0]!.resetsAt).toBeNull();
  expect(usage.windows[0]!.usedPercent).toBe(60);
  expect(usage.plan).toBeNull();
});

test("empty snapshots are recognised without fabricating usage", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_snapshots: {} }));
  expect(usage.windows).toEqual([]);
});

for (const status of [401, 403, 429, 500]) {
  test(`Copilot HTTP ${status} becomes a usage error`, async () => {
    await expect(fetchGitHubCopilotSubscriptionUsage("secret", async () => new Response("secret", { status }))).rejects.toThrow(status === 401 ? "Reconnect GitHub Copilot" : `HTTP ${status}`);
  });
}

test("network failures do not expose credentials", async () => {
  await expect(fetchGitHubCopilotSubscriptionUsage("secret", async () => { throw new Error("secret"); })).rejects.toThrow("Could not reach GitHub Copilot");
});

test("invalid JSON is a usage error", async () => {
  await expect(fetchGitHubCopilotSubscriptionUsage("token", async () => new Response("not json"))).rejects.toThrow("invalid usage response");
});

for (const data of [ { ...payload(), quota_reset_date: "bad date" }, { quota_snapshots: { chat: { entitlement: "not a number" } } } ]) {
  test(`rejects unrecognised Copilot response ${JSON.stringify(data)}`, async () => {
    await expect(fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json(data))).rejects.toThrow("unrecognized usage response");
  });
}

for (const [reset, start, days] of [
  ["2026-03-01", "2026-02-01", 28],
  ["2028-03-01", "2028-02-01", 29],
  ["2026-05-01", "2026-04-01", 30],
  ["2027-01-01", "2026-12-01", 31],
] as const) {
  test(`calendar month ending ${reset} computes elapsed time, pace and exhaustion using ${days} days`, async () => {
    const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_reset_date_utc: `${reset}T00:00:00Z`, quota_snapshots: { premium_interactions: { percent_remaining: 25 } } }));
    const reported = usage.windows[0]!;
    expect(reported.durationSeconds).toBe(days * 86400);
    const at = new Date(new Date(start).getTime() + days / 2 * 86400_000);
    const timing = usageWindowTiming(reported, at);
    expect(timing.startsAt).toBe(`${start}T00:00:00.000Z`);
    expect(timing.elapsedPercent).toBe(50);
    expect(timing.paceDifferencePoints).toBe(25);
    expect(timing.paceDifferenceSeconds).toBe(days / 4 * 86400);
    expect(estimatedTimeToHitLimitSeconds({ reported, timing })).toBeCloseTo(days / 6 * 86400, 6);
    expect(usageWindowTiming(reported, new Date(start)).elapsedPercent).toBe(0);
    const due = usageWindowTiming(reported, new Date(reset));
    expect(due.state).toBe("reset-due");
    expect(due.elapsedPercent).toBe(100);
    expect(due.paceDifferenceSeconds).toBeNull();
    const notStarted = usageWindowTiming(reported, new Date(new Date(start).getTime() - 1));
    expect(notStarted.state).toBe("not-started");
    expect(notStarted.paceDifferenceSeconds).toBeNull();
  });
}

test("UTC reset date takes priority over the older date-only field", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_reset_date_utc: "2026-12-01T00:00:00Z" }));
  expect(usage.windows[0]!.resetsAt).toBe("2026-12-01T00:00:00.000Z");
  expect(usage.windows[0]!.durationSeconds).toBe(30 * 86400);
});

test("each quota's epoch-seconds reset overrides account dates independently", async () => {
  // Keep both per-quota resets in the future so this tests precedence, not expiry.
  setSystemTime(new Date("2026-10-14T12:00:00Z"));
  try {
    const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_reset_date_utc: "2026-12-01T00:00:00Z", quota_snapshots: {
      premium_interactions: { percent_remaining: 25, quota_reset_at: Date.parse("2026-11-01T00:00:00Z") / 1000 },
      chat: { percent_remaining: 50, quota_reset_at: Date.parse("2026-10-15T13:00:00Z") / 1000 },
    } }));
    expect(usage.windows[0]!.resetsAt).toBe("2026-11-01T00:00:00.000Z");
    expect(usage.windows[0]!.durationSeconds).toBe(31 * 86400);
    expect(usage.allowances?.find((allowance) => allowance.quotaId === "chat")?.resetsAt).toBe("2026-10-15T13:00:00.000Z");
    expect(usage.windows).toHaveLength(1);
  } finally { setSystemTime(); }
});

test("offset timestamps resolve to UTC without daylight-saving or host-timezone shifts", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_reset_date_utc: "2026-10-31T20:00:00-04:00" }));
  expect(usage.windows[0]!.resetsAt).toBe("2026-11-01T00:00:00.000Z");
  expect(usage.windows[0]!.durationSeconds).toBe(31 * 86400);
});

for (const reset of ["2026-02-30", "2026-11-01T00:00:00"]) {
  test(`rejects ambiguous or invalid reset ${reset}`, async () => {
    await expect(fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_reset_date: reset }))).rejects.toThrow("unrecognized");
  });
}

test("current credit fields accept string entitlements and prefer quota_remaining over legacy remaining", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), token_based_billing: true, quota_snapshots: {
    premium_interactions: { entitlement: "300.00", quota_remaining: 210, remaining: 10 },
    chat: { entitlement: "100", credits_used: 25 },
  } }));
  expect(usage.windows[0]!.limitName).toBe("AI credits");
  expect(usage.windows[0]!.usedPercent).toBe(30);
  expect(usage.allowances?.find((allowance) => allowance.quotaId === "chat")?.remainingPercent).toBe(75);
  expect(usage.allowances?.[0]!.remainingPercentSource).toBe("quantity-estimate");
});

test("zero-entitlement and unlimited categories do not cause division by zero or false exhaustion", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_interactions: { entitlement: "0", percent_remaining: 0 }, chat: { entitlement: "-1", percent_remaining: 0 },
  } }));
  expect(usage.windows).toEqual([]);
  expect(usage.limitReached).toBeNull();
});

test("paid overage does not signal blocked access, but preserves allowance exhaustion", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_interactions: { percent_remaining: 0, overage_permitted: true },
  } }));
  expect(usage.limitReached).toBeNull();
  expect(usage.windows[0]!.usedPercent).toBe(100);
  const reported = usage.windows[0]!;
  expect(estimatedTimeToHitLimitSeconds({ reported, timing: usageWindowTiming(reported, new Date("2026-10-15")) })).toBe(0);
});

test("rounding and overage percentages stay within the displayed allowance range", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_interactions: { percent_remaining: -1 }, chat: { percent_remaining: 101 },
  } }));
  expect(usage.windows.map(window => window.usedPercent)).toEqual([100]);
  expect(usage.allowances?.map(allowance => allowance.remainingPercent)).toEqual([0, 100]);
});

test("free-plan reset date also supports calendar pacing", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ copilot_plan: "free", limited_user_reset_date: "2026-11-01", quota_snapshots: { chat: { entitlement: 50, remaining: 25 } } }));
  expect(usage.windows[0]!.durationSeconds).toBe(31 * 86400);
  expect(usage.windows[0]!.usedPercent).toBe(50);
});

test("paid accounts prefer premium_models without merging premium_interactions or chat", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_models: { entitlement: 300, remaining: 180, percent_remaining: 60, quota_id: "premium" },
    premium_interactions: { entitlement: 300, remaining: 30, percent_remaining: 10 },
    chat: { entitlement: -1, remaining: -1, unlimited: true, percent_remaining: 100 },
    completions: { entitlement: -1, unlimited: true },
  } }));
  expect(usage.windows).toHaveLength(1);
  expect(usage.windows[0]!.meteredFeature).toBe("premium_models");
  expect(usage.windows[0]!.usedPercent).toBe(40);
  expect(usage.allowances).toHaveLength(4);
  expect(usage.allowances?.filter(allowance => allowance.selected).map(allowance => allowance.quotaId)).toEqual(["premium_models"]);
  expect(usage.allowances?.[0]!.sourceQuotaId).toBe("premium");
  expect(usage.allowances?.find(allowance => allowance.quotaId === "chat")?.unlimited).toBe(true);
  expect(usage.allowances?.find(allowance => allowance.quotaId === "completions")?.unlimited).toBe(true);
});

for (const classification of [{ copilot_plan: "free" }, { copilot_plan: "unknown", access_type_sku: "free_limited_copilot" }]) {
  test(`free classification ${JSON.stringify(classification)} selects chat independently of premium usage`, async () => {
    const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), ...classification, quota_snapshots: {
      chat: { entitlement: 50, remaining: 40, percent_remaining: 80 },
      premium_models: { entitlement: 300, percent_remaining: 0 },
    } }));
    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]!.limitName).toBe("Chat requests");
    expect(usage.windows[0]!.usedPercent).toBe(20);
    expect(usage.allowances?.find(allowance => allowance.selected)?.quotaId).toBe("chat");
    expect(usage.allowed).toBeNull();
  });
}

test("unlimited primary allowance is a reported state, not zero usage or missing quota", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_models: { entitlement: "-1", remaining: -1, unlimited: true, percent_remaining: 100 },
  } }));
  expect(usage.windows).toEqual([]);
  expect(usage.allowances?.[0]).toMatchObject({ selected: true, unlimited: true, entitlement: -1, remaining: -1 });
});

test("rounded percentages never replace exact remaining amounts and overage is kept separate", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 179.875, percent_remaining: 60, overage_count: "0.0125", overage_permitted: true },
  } }));
  expect(usage.windows[0]!.usedPercent).toBe(40);
  expect(usage.allowances?.[0]).toMatchObject({ remaining: 179.875, remainingPercent: 60, remainingPercentSource: "reported", overageCount: 0.0125, overagePermitted: true, unit: "requests" });
});

for (const data of [{}, { quota_snapshots: { premium_interactions: {} } }, { quota_snapshots: { premium_interactions: { entitlement: 300, quota_reset_at: null } } }]) {
  test(`incomplete snapshot ${JSON.stringify(data)} stays unknown`, async () => {
    const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json(data));
    expect(usage.windows).toEqual([]);
    expect(usage.allowed).toBeNull();
    expect(usage.limitReached).toBeNull();
    if (usage.allowances?.length) expect(usage.allowances[0]!.remainingPercent).toBeNull();
  });
}

test("missing free chat does not silently substitute an exhausted premium bucket", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), copilot_plan: "free", quota_snapshots: { premium_interactions: { percent_remaining: 0 } } }));
  expect(usage.windows).toEqual([]);
  expect(usage.allowances?.some(allowance => allowance.selected)).toBe(false);
});

test("unknown billing generation uses a neutral label instead of inventing request or credit units", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_snapshots: { premium_models: { entitlement: 300, percent_remaining: 60 } } }));
  expect(usage.windows[0]!.limitName).toBe("Premium allowance");
  expect(usage.allowances?.[0]!.unit).toBe("unknown");
});

// Shapes below follow CodexBar's Copilot fixtures (github.com/steipete/CodexBar).
test("token-billed placeholders fall back to monthly completions and keep the credit counter", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({
    copilot_plan: "business", token_based_billing: true, quota_reset_date: "2026-11-01",
    monthly_quotas: { completions: 300 }, limited_user_quotas: { completions: 75 },
    quota_snapshots: {
      premium_interactions: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, quota_id: "premium_interactions", credits_used: 31 },
      chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, quota_id: "chat", credits_used: 0 },
    },
  }));
  expect(usage.windows).toEqual([{ periodBasis: "calendar-month-estimate", limitName: "Code completions", meteredFeature: "completions", kind: "primary", usedPercent: 75, durationSeconds: 31 * 86400, resetsAt: "2026-11-01T00:00:00.000Z" }]);
  expect(usage.allowances?.find((allowance) => allowance.quotaId === "premium_interactions")).toMatchObject({ selected: false, creditsUsed: 31 });
  expect(usage.allowances?.find((allowance) => allowance.quotaId === "completions")).toMatchObject({ selected: true, entitlement: 300, remaining: 75, sourceQuotaId: "monthly_quotas" });
});

test("token-billed placeholders without counts report credits used and no fake percentage", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({
    copilot_plan: "business", token_based_billing: true, quota_reset_date: "2026-11-01",
    quota_snapshots: { premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100, credits_used: 31 } },
  }));
  expect(usage.windows).toEqual([]);
  expect(usage.allowances?.[0]).toMatchObject({ selected: true, entitlement: 0, creditsUsed: 31 });
});

test("free plans without snapshots read monthly and remaining counts", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({
    copilot_plan: "free", access_type_sku: "free_limited_copilot", limited_user_reset_date: "2026-11-01",
    monthly_quotas: { chat: 50, completions: 2000 }, limited_user_quotas: { chat: 40, completions: 1500 },
  }));
  expect(usage.windows).toHaveLength(1);
  expect(usage.windows[0]).toMatchObject({ meteredFeature: "chat", usedPercent: 20 });
  expect(usage.allowances?.find((allowance) => allowance.quotaId === "completions")?.remainingPercent).toBe(75);
});

test("renamed snapshot categories fill missing known ones", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_reset_date: "2026-11-01", quota_snapshots: {
    premium_interactions: { entitlement: 200, remaining: 191, percent_remaining: 95.5 },
    chat_messages: { entitlement: 0, remaining: 0, unlimited: true },
    mystery: "not a quota",
  } }));
  expect(usage.allowances?.find((allowance) => allowance.quotaId === "chat")).toMatchObject({ sourceQuotaId: "chat_messages", unlimited: true });
  expect(usage.windows[0]!.usedPercent).toBeCloseTo(4.5);
});

test("billing-anniversary resets still pace over the month before the reset", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_reset_date: "2026-03-31" }));
  expect(usage.windows[0]!.durationSeconds).toBe(31 * 86400);
  expect(usageWindowTiming(usage.windows[0]!, new Date("2026-03-15T00:00:00Z")).startsAt).toBe("2026-02-28T00:00:00.000Z");
});

test("fractional quota_reset_at seconds are accepted", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_snapshots: { premium_interactions: { percent_remaining: 70, quota_reset_at: Date.parse("2026-11-01T00:00:00Z") / 1000 + 0.5 } } }));
  expect(usage.windows[0]!.resetsAt).toBe("2026-11-01T00:00:00.000Z");
});

test("string percentages and renamed premium buckets are metered", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_snapshots: { premium_requests: { percent_remaining: "70.5", entitlement: "300" } } }));
  expect(usage.windows[0]!.usedPercent).toBe(29.5);
  expect(usage.allowances?.[0]!.sourceQuotaId).toBe("premium_requests");
});

for (const quotaReset of [0, Date.parse("2000-01-01") / 1000]) {
  test(`missing/stale per-quota reset ${quotaReset} doesn't override a future account reset`, async () => {
    const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({
      copilot_plan: "individual", token_based_billing: true, quota_reset_date_utc: "2100-11-01T00:00:00Z",
      quota_snapshots: { premium_models: { entitlement: 1_000_000, remaining: 870496.6, percent_remaining: 87, credits_used: 129503, quota_reset_at: quotaReset } },
    }));
    expect(usage.windows[0]).toMatchObject({ usedPercent: 13, resetsAt: "2100-11-01T00:00:00.000Z", durationSeconds: 31 * 86400 });
    expect(usage.allowances?.[0]).toMatchObject({ creditsUsed: 129503, remaining: 870496.6, resetsAt: "2100-11-01T00:00:00.000Z" });
  });
}

test("a zero per-quota reset without account timing leaves pacing unknown", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_snapshots: { premium_models: { percent_remaining: 87, quota_reset_at: 0 } } }));
  expect(usage.windows[0]).toMatchObject({ usedPercent: 13, resetsAt: null, durationSeconds: null });
  expect(usageWindowTiming(usage.windows[0]!, new Date(usage.checkedAt)).state).toBe("unknown");
});

test("when all reset dates are past, preserve reported timing without rolling it forward", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_reset_date: "2000-02-01", quota_snapshots: { premium_models: { percent_remaining: 87, quota_reset_at: Date.parse("2000-01-01") / 1000 } } }));
  expect(usage.windows[0]).toMatchObject({ usedPercent: 13, resetsAt: "2000-01-01T00:00:00.000Z" });
  const paced = { reported: usage.windows[0]!, timing: usageWindowTiming(usage.windows[0]!, new Date(usage.checkedAt)) };
  expect(paced.timing.state).toBe("reset-due");
  expect(paced.timing.paceDifferenceSeconds).toBeNull();
});

test("known premium placeholders don't suppress renamed buckets carrying real consumption", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ token_based_billing: true, quota_snapshots: {
    premium_models: { entitlement: 0, remaining: 0, percent_remaining: 100 },
    premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100, credits_used: 31 },
    premium_new_credits: { entitlement: 1000, remaining: 870, percent_remaining: 87 },
  } }));
  expect(usage.windows[0]!.usedPercent).toBe(13);
  expect(usage.allowances?.find((allowance) => allowance.selected)).toMatchObject({ sourceQuotaId: "premium_new_credits", creditsUsed: 31 });
});

// Ported from upstream 75d53ea3 without replacing Kintsugi's allowance normalization.
for (const [host, expected] of [
  ["github.example.ghe.com", "https://api.github.example.ghe.com/copilot_internal/user"],
  ["https://github.example.ghe.com/", "https://api.github.example.ghe.com/copilot_internal/user"],
  ["api.github.example.ghe.com", "https://api.github.example.ghe.com/copilot_internal/user"],
] as const) {
  test(`Copilot usage follows the enterprise issuer ${host}`, async () => {
    const usage = await fetchGitHubCopilotSubscriptionUsage("enterprise-oauth", async (url, init) => {
      expect(url).toBe(expected);
      expect(new Headers(init.headers).get("authorization")).toBe("token enterprise-oauth");
      return Response.json(payload());
    }, host);
    expect(usage.windows[0]!.usedPercent).toBe(30);
  });
}

for (const host of ["http://github.example.com", "https://user:do-not-reflect@github.example.com", "https://github.example.com/path", "https://github.example.com?token=do-not-reflect", "https://github.example.com#fragment", "https://github.example.com:8443", "not a hostname"]) {
  test(`invalid enterprise metadata is rejected before credentials are sent: ${host}`, async () => {
    let requested = false;
    const error = await fetchGitHubCopilotSubscriptionUsage("fixture-secret", async () => { requested = true; return Response.json(payload()); }, host).catch((error: Error) => error);
    expect(requested).toBe(false);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected a credential error");
    expect(error.message).toContain("Reconnect GitHub Copilot");
    expect(error.message).not.toContain("fixture-secret");
    expect(error.message).not.toContain("do-not-reflect");
  });
}
