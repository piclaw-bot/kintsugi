import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { monthlyDurationSeconds } from "./usage-window.ts";
import { fetchSubscriptionUsageJson, parseSubscriptionUsageDate, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage, type ReportedAllowance } from "./subscription-usage.ts";

const countSchema = Type.Union([Type.Number(), Type.String({ pattern: "^-?\\d+(?:\\.\\d+)?$" })]);
const dateSchema = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const quotaSchema = Type.Object({
  unlimited: Type.Optional(Type.Boolean()),
  percent_remaining: Type.Optional(countSchema),
  remaining: Type.Optional(countSchema),
  quota_remaining: Type.Optional(countSchema),
  credits_used: Type.Optional(countSchema),
  entitlement: Type.Optional(countSchema),
  overage_permitted: Type.Optional(Type.Boolean()),
  overage_count: Type.Optional(countSchema),
  quota_id: Type.Optional(Type.String()),
  // Epoch seconds; GitHub sometimes sends fractional seconds.
  quota_reset_at: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 8640000000000 }), Type.Null()])),
});
type Quota = Static<typeof quotaSchema>;
// Older and free-plan responses report totals and remaining counts here instead of snapshots.
const quotaCountsSchema = Type.Optional(Type.Union([Type.Object({ chat: Type.Optional(countSchema), completions: Type.Optional(countSchema) }), Type.Null()]));
const payloadSchema = Type.Object({
  copilot_plan: Type.Optional(Type.String()),
  access_type_sku: Type.Optional(Type.String()),
  quota_reset_date: dateSchema,
  quota_reset_date_utc: dateSchema,
  limited_user_reset_date: dateSchema,
  token_based_billing: Type.Optional(Type.Boolean()),
  monthly_quotas: quotaCountsSchema,
  limited_user_quotas: quotaCountsSchema,
  quota_snapshots: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
});

const knownFeatures = ["premium_models", "premium_interactions", "chat", "completions"] as const;
type Feature = typeof knownFeatures[number];
const knownFeatureNames = new Set<string>(knownFeatures);
type Snapshots = { premium_models?: Quota; premium_interactions?: Quota; chat?: Quota; completions?: Quota };

/** Known categories must parse; unfamiliar ones fill a missing known category by name, as GitHub has renamed them before. */
function quotaSnapshots(raw: Static<typeof payloadSchema>["quota_snapshots"], unrecognized: string): Snapshots {
  const snapshots: Snapshots = {};
  for (const feature of knownFeatures) {
    const quota = raw?.[feature];
    if (quota == null) continue;
    if (!Value.Check(quotaSchema, quota)) throw new SubscriptionUsageError(unrecognized);
    snapshots[feature] = quota;
  }
  const meteredQuota = (quota: Quota) => {
    const entitlement = quota.entitlement === undefined ? undefined : Number(quota.entitlement);
    const remaining = quota.percent_remaining === undefined ? undefined : Number(quota.percent_remaining);
    const quantity = quota.quota_remaining ?? quota.remaining ?? quota.credits_used;
    return !quota.unlimited && entitlement !== 0 && entitlement !== -1 && (remaining !== undefined && Number.isFinite(remaining) || entitlement !== undefined && entitlement > 0 && Number.isFinite(entitlement) && quantity !== undefined && Number.isFinite(Number(quantity)));
  };
  for (const [key, quota] of Object.entries(raw ?? {})) {
    if (knownFeatureNames.has(key) || !Value.Check(quotaSchema, quota)) continue;
    const name = key.toLowerCase();
    const feature: Feature | undefined = name.includes("chat") ? "chat" : name.includes("premium") ? "premium_interactions" : name.includes("completion") || name.includes("code") ? "completions" : undefined;
    if (!feature) continue;
    const existing = snapshots[feature];
    // A renamed bucket with actual numbers is preferable to a known zero-entitlement placeholder.
    if (!existing || !meteredQuota(existing) && meteredQuota(quota)) snapshots[feature] = { quota_id: key, ...quota, credits_used: quota.credits_used ?? existing?.credits_used };
  }
  return snapshots;
}

/** GitHub's internal Copilot endpoint, also used by PiClaw and CodexBar. Requires the GitHub
 * OAuth token stored as `refresh`, not Pi's resolved Copilot inference token. */
export async function fetchGitHubCopilotSubscriptionUsage(githubToken: string, fetcher: Fetcher = fetch): Promise<SubscriptionUsage> {
  const messages = subscriptionUsageMessages("GitHub Copilot");
  const payload = await fetchSubscriptionUsageJson("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `token ${githubToken}`, Accept: "application/json",
      "Editor-Version": "vscode/1.96.2", "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "GitHubCopilotChat/0.26.7", "X-Github-Api-Version": "2025-04-01",
    },
  }, payloadSchema, { ...messages, unavailable: (status) => status === 403 ? "GitHub denied the usage check (HTTP 403). Check your account access or policy." : status === 429 ? "GitHub rate-limited usage checks (HTTP 429). Try again later." : messages.unavailable(status) }, fetcher);
  const accountReset = parseSubscriptionUsageDate(payload.quota_reset_date_utc ?? payload.quota_reset_date ?? payload.limited_user_reset_date, messages.unrecognized);
  const checkedAt = new Date();
  const snapshots = quotaSnapshots(payload.quota_snapshots, messages.unrecognized);
  const free = payload.copilot_plan === "free" || payload.access_type_sku === "free_limited_copilot";
  const premiumLabel = payload.token_based_billing === true ? "AI credits" : payload.token_based_billing === false ? "Premium requests" : "Premium allowance";
  const allowances: ReportedAllowance[] = [];
  const allowance = (feature: Feature, quota: Quota): ReportedAllowance => {
    const entitlement = quota.entitlement === undefined ? undefined : Number(quota.entitlement);
    if (entitlement !== undefined && (!Number.isFinite(entitlement) || (entitlement < 0 && entitlement !== -1))) throw new SubscriptionUsageError(messages.unrecognized);
    const remainingCount = quota.quota_remaining ?? quota.remaining;
    const remainingQuantity = remainingCount === undefined ? null : Number(remainingCount);
    let remaining = quota.percent_remaining === undefined ? undefined : Number(quota.percent_remaining);
    if (remaining === undefined && entitlement !== undefined && entitlement > 0) {
      if (remainingQuantity !== null) remaining = remainingQuantity / entitlement * 100;
      else if (quota.credits_used !== undefined) remaining = 100 - Number(quota.credits_used) / entitlement * 100;
    }
    const overageCount = quota.overage_count === undefined ? null : Number(quota.overage_count);
    const creditsUsed = quota.credits_used === undefined ? null : Number(quota.credits_used);
    if ((remaining !== undefined && !Number.isFinite(remaining)) || (remainingQuantity !== null && !Number.isFinite(remainingQuantity)) || (overageCount !== null && (!Number.isFinite(overageCount) || overageCount < 0)) || (creditsUsed !== null && (!Number.isFinite(creditsUsed) || creditsUsed < 0))) throw new SubscriptionUsageError(messages.unrecognized);
    // A zero epoch is missing timing, not January 1970. Prefer per-quota timing unless it has
    // expired while the account reports a future reset; that is the only newer timing we can use
    // without inventing a period. If both have expired, retain that fact and show usage without pacing.
    const quotaReset = quota.quota_reset_at != null && quota.quota_reset_at > 0 ? new Date(Math.floor(quota.quota_reset_at) * 1000) : null;
    const staleQuota = quotaReset !== null && quotaReset.getTime() <= checkedAt.getTime();
    const futureAccount = accountReset !== null && accountReset.getTime() > checkedAt.getTime();
    const reset = staleQuota && futureAccount ? accountReset : quotaReset ?? accountReset;
    const label = feature === "chat" ? "Chat requests" : feature === "completions" ? "Code completions" : premiumLabel;
    return {
      quotaId: feature, sourceQuotaId: quota.quota_id ?? null, label,
      unit: feature === "chat" ? "requests" : feature === "completions" ? "completions" : payload.token_based_billing === true ? "credits" : payload.token_based_billing === false ? "requests" : "unknown",
      selected: false, entitlement: entitlement ?? null, remaining: remainingQuantity,
      remainingPercent: remaining === undefined ? null : Math.max(0, Math.min(100, remaining)),
      remainingPercentSource: quota.percent_remaining !== undefined ? "reported" : remaining === undefined ? "unknown" : "quantity-estimate",
      unlimited: quota.unlimited === true || entitlement === -1, overageCount, overagePermitted: quota.overage_permitted ?? null,
      creditsUsed, resetsAt: reset?.toISOString() ?? null,
    };
  };
  // Token-billed seats report zero-entitlement placeholders (often marked unlimited) and carry real
  // counts in monthly_quotas/limited_user_quotas instead, as CodexBar handles.
  const metered = (entry: ReportedAllowance | undefined) => entry !== undefined && !entry.unlimited && entry.entitlement !== 0 && entry.remainingPercent !== null;
  for (const feature of knownFeatures) {
    const quota = snapshots[feature];
    if (quota) allowances.push(allowance(feature, quota));
  }
  for (const feature of ["chat", "completions"] as const) {
    const total = payload.monthly_quotas?.[feature];
    const left = payload.limited_user_quotas?.[feature];
    if (total === undefined || left === undefined || Number(total) <= 0) continue;
    const index = allowances.findIndex((entry) => entry.quotaId === feature);
    if (metered(allowances[index])) continue;
    const fallback = allowance(feature, { entitlement: total, remaining: left, quota_id: "monthly_quotas" });
    // Keep a placeholder's absolute credit counter on the replacement, as it is still real consumption.
    if (index === -1) allowances.push(fallback);
    else allowances[index] = { ...fallback, creditsUsed: allowances[index]!.creditsUsed };
  }
  const find = (feature: Feature) => allowances.find((entry) => entry.quotaId === feature);
  // Free accounts are metered by chat. Paid accounts prefer the newest premium category that isn't a
  // zero-entitlement placeholder; when it has no numbers, monthly completions counts stand in for it.
  const premium = (["premium_models", "premium_interactions"] as const).map(find).find((entry) => entry !== undefined && entry.entitlement !== 0);
  const monthlyCompletions = find("completions");
  const primary = free ? find("chat")
    : metered(premium) ? premium
    : monthlyCompletions?.sourceQuotaId === "monthly_quotas" && metered(monthlyCompletions) ? monthlyCompletions
    : premium ?? (metered(monthlyCompletions) ? monthlyCompletions : undefined) ?? find("premium_models") ?? find("premium_interactions") ?? find("chat");
  if (primary) primary.selected = true;
  if (find("premium_models") && find("premium_interactions")) find("premium_interactions")!.label = "Premium interactions";
  const windows: SubscriptionUsage["windows"] = [];
  // Only the account-appropriate allowance drives pacing; alternative categories
  // remain separate observations and are never added to its consumption.
  if (primary && metered(primary)) {
    const reset = primary.resetsAt === null ? null : new Date(primary.resetsAt);
    windows.push({ periodBasis: "calendar-month-estimate", limitName: primary.label, meteredFeature: primary.quotaId, kind: "primary", usedPercent: 100 - primary.remainingPercent!, durationSeconds: monthlyDurationSeconds(reset), resetsAt: primary.resetsAt });
  }
  return {
    plan: payload.copilot_plan ?? null, checkedAt: checkedAt.toISOString(),
    allowed: null, limitReached: null, allowances, windows,
  };
}
