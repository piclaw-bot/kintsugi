import { fetchSubscriptionUsageJson, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";
import { codexTokenClaims } from "./codex-token.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { monthlyDurationSeconds } from "./usage-window.ts";

const claimsSchema = Type.Object({ "https://api.openai.com/auth": Type.Optional(Type.Object({ chatgpt_account_id: Type.Optional(Type.String({ minLength: 1 })) })) });
const windowSchema = Type.Object({
  // Can pass 100 once an allowance is exhausted.
  used_percent: Type.Number({ minimum: 0 }),
  limit_window_seconds: Type.Integer({ minimum: 1 }),
  reset_at: Type.Integer({ minimum: 0, maximum: 8640000000000 }),
});
// Numbers sometimes arrive as strings, as CodexBar also handles.
const amountSchema = Type.Union([Type.Number(), Type.String({ pattern: "^\\s*-?\\d+(?:\\.\\d+)?\\s*$" }), Type.Null()]);
/** A team or enterprise workspace's monthly credit cap for this member. */
const individualLimitSchema = Type.Union([Type.Object({
  limit: Type.Optional(amountSchema),
  used: Type.Optional(amountSchema),
  remaining_percent: Type.Optional(amountSchema),
  remainingPercent: Type.Optional(amountSchema),
  resets_at: Type.Optional(amountSchema),
  reset_at: Type.Optional(amountSchema),
  resetsAt: Type.Optional(amountSchema),
}), Type.Null()]);
const limitsSchema = Type.Object({
  allowed: Type.Optional(Type.Boolean()),
  limit_reached: Type.Optional(Type.Boolean()),
  individual_limit: Type.Optional(individualLimitSchema),
  primary_window: Type.Optional(Type.Union([windowSchema, Type.Null()])),
  secondary_window: Type.Optional(Type.Union([windowSchema, Type.Null()])),
});
const payloadSchema = Type.Object({
  plan_type: Type.Optional(Type.String()),
  credits: Type.Optional(Type.Union([Type.Object({
    unlimited: Type.Optional(Type.Boolean()),
    balance: Type.Optional(amountSchema),
  }), Type.Null()])),
  individual_limit: Type.Optional(individualLimitSchema),
  spend_control: Type.Optional(Type.Union([Type.Object({ individual_limit: Type.Optional(individualLimitSchema) }), Type.Null()])),
  rate_limit_reset_credits: Type.Optional(Type.Union([Type.Object({
    available_count: Type.Integer({ minimum: 0 }),
  }), Type.Null()])),
  chatpass: Type.Optional(Type.Union([Type.Object({ windows: Type.Array(windowSchema) }), Type.Null()])),
  rate_limit: Type.Optional(Type.Union([limitsSchema, Type.Null()])),
  code_review_rate_limit: Type.Optional(Type.Union([limitsSchema, Type.Null()])),
  // Checked per entry, so one unfamiliar model limit can't hide the main windows.
  additional_rate_limits: Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.Null()])),
});
const additionalLimitSchema = Type.Object({
  limit_name: Type.String(), metered_feature: Type.String(),
  rate_limit: Type.Optional(Type.Union([limitsSchema, Type.Null()])),
});

/** ChatGPT's account endpoint, also used by the Codex CLI. Not a public, versioned API. */
export async function fetchCodexSubscriptionUsage(accessToken: string, fetcher: Fetcher = fetch): Promise<SubscriptionUsage> {
  let claims: Static<typeof claimsSchema>;
  try {
    claims = codexTokenClaims(accessToken, claimsSchema);
  } catch {
    throw new SubscriptionUsageError("OpenAI credentials are invalid. Reconnect OpenAI Codex.");
  }
  const headers = new Headers({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" });
  const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (accountId) headers.set("ChatGPT-Account-Id", accountId);
  return normalizeUsage(await fetchSubscriptionUsageJson("https://chatgpt.com/backend-api/wham/usage", { headers }, payloadSchema, subscriptionUsageMessages("OpenAI", "OpenAI Codex"), fetcher));
}

const amount = (value: Static<typeof amountSchema> | undefined) => value === null || value === undefined ? undefined : Number(value);

/** Monthly credit pools report used/limit or a remaining percentage rather than a window. */
function creditLimitWindow(limit: Static<typeof individualLimitSchema> | undefined): SubscriptionUsage["windows"] {
  const cap = amount(limit?.limit);
  if (!limit || cap === undefined || cap <= 0) return [];
  if (!Number.isFinite(cap)) throw new SubscriptionUsageError("OpenAI returned an unrecognized usage response.");
  const used = amount(limit.used);
  const remaining = amount(limit.remaining_percent ?? limit.remainingPercent);
  const usedPercent = remaining !== undefined ? 100 - remaining : used !== undefined ? used / cap * 100 : undefined;
  if (usedPercent === undefined) return [];
  if (!Number.isFinite(usedPercent) || (used !== undefined && used < 0)) throw new SubscriptionUsageError("OpenAI returned an unrecognized usage response.");
  const resetSeconds = amount(limit.resets_at ?? limit.reset_at ?? limit.resetsAt);
  if (resetSeconds !== undefined && (!Number.isFinite(resetSeconds) || resetSeconds < 0 || resetSeconds > 8640000000000)) throw new SubscriptionUsageError("OpenAI returned an unrecognized usage response.");
  const reset = resetSeconds === undefined || resetSeconds <= 0 ? null : new Date(Math.floor(resetSeconds) * 1000);
  return [{ periodBasis: "calendar-month-estimate", limitName: "Monthly credits", meteredFeature: "credits", kind: "primary", usedPercent: Math.max(0, Math.min(100, usedPercent)), durationSeconds: monthlyDurationSeconds(reset), resetsAt: reset?.toISOString() ?? null }];
}

function normalizeUsage(payload: Static<typeof payloadSchema>): SubscriptionUsage {
  if (!Object.keys(payload).some((key) => ["plan_type", "rate_limit", "credits", "code_review_rate_limit", "additional_rate_limits", "individual_limit", "spend_control", "chatpass"].includes(key))) throw new SubscriptionUsageError("OpenAI returned an unrecognized usage response.");
  const limits = payload.rate_limit;
  const additional = (payload.additional_rate_limits ?? []).filter((entry) => Value.Check(additionalLimitSchema, entry));
  const usage: SubscriptionUsage = {
    plan: payload.plan_type ?? null,
    checkedAt: new Date().toISOString(),
    allowed: limits?.allowed ?? null,
    limitReached: limits?.limit_reached ?? null,
    windows: [
      { limit_name: "Codex", metered_feature: null, rate_limit: limits },
      ...(payload.code_review_rate_limit ? [{ limit_name: "Code review", metered_feature: "code_review", rate_limit: payload.code_review_rate_limit }] : []),
      ...additional,
    ].flatMap((group) => (["primary", "secondary"] as const).flatMap((kind) => {
      const window = group.rate_limit?.[`${kind}_window`];
      return window ? [{ limitName: group.limit_name, meteredFeature: group.metered_feature, kind, usedPercent: Math.min(100, window.used_percent), durationSeconds: window.limit_window_seconds, resetsAt: new Date(window.reset_at * 1000).toISOString() }] : [];
    })).concat((payload.chatpass?.windows ?? []).map((window) => ({
      limitName: "Chatpass", meteredFeature: "chatpass", kind: "primary" as const,
      usedPercent: Math.min(100, window.used_percent), durationSeconds: window.limit_window_seconds,
      resetsAt: new Date(window.reset_at * 1000).toISOString(),
    }))),
  };
  usage.windows.push(...creditLimitWindow(payload.individual_limit ?? limits?.individual_limit ?? payload.spend_control?.individual_limit));
  if (payload.credits) usage.credits = {
    unlimited: payload.credits.unlimited ?? false,
    balance: payload.credits.balance === null || payload.credits.balance === undefined ? null : String(payload.credits.balance).trim(),
  };
  if (payload.rate_limit_reset_credits) usage.resets = {
    available: payload.rate_limit_reset_credits.available_count,
  };
  return usage;
}
