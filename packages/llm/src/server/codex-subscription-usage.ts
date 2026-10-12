import { fetchSubscriptionUsageJson, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";
import { codexTokenClaims } from "./codex-token.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { monthlyDurationSeconds } from "./usage-window.ts";

const claimsSchema = Type.Object({ "https://api.openai.com/auth": Type.Optional(Type.Object({ chatgpt_account_id: Type.Optional(Type.String({ minLength: 1 })) })) });
const windowSchema = Type.Object({
  // Can pass 100 once an allowance is exhausted.
  used_percent: Type.Number({ minimum: 0 }),
  limit_window_seconds: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 8640000000000 }), Type.Null()])),
  reset_at: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 8640000000000 }), Type.Null()])),
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
  individualLimit: Type.Optional(individualLimitSchema),
  primary_window: Type.Optional(Type.Union([windowSchema, Type.Null()])),
  secondary_window: Type.Optional(Type.Union([windowSchema, Type.Null()])),
});
const spendControlSchema = Type.Union([Type.Object({ individual_limit: Type.Optional(individualLimitSchema), individualLimit: Type.Optional(individualLimitSchema) }), Type.Null()]);
const payloadSchema = Type.Object({
  plan_type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  credits: Type.Optional(Type.Union([Type.Object({
    unlimited: Type.Optional(Type.Boolean()),
    balance: Type.Optional(amountSchema),
  }), Type.Null()])),
  individual_limit: Type.Optional(individualLimitSchema),
  individualLimit: Type.Optional(individualLimitSchema),
  spend_control: Type.Optional(spendControlSchema),
  spendControl: Type.Optional(spendControlSchema),
  rate_limit_reset_credits: Type.Optional(Type.Union([Type.Object({
    available_count: Type.Integer({ minimum: 0 }),
  }), Type.Null()])),
  chatpass: Type.Optional(Type.Unknown()),
  rate_limit: Type.Optional(Type.Union([limitsSchema, Type.Null()])),
  code_review_rate_limit: Type.Optional(Type.Unknown()),
  // Checked per entry, so one unfamiliar model limit can't hide the main windows.
  additional_rate_limits: Type.Optional(Type.Unknown()),
});
const additionalLimitSchema = Type.Object({
  limit_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metered_feature: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  rate_limit: Type.Optional(Type.Unknown()),
});
const additionalWindowsSchema = Type.Object({ primary_window: Type.Optional(Type.Unknown()), secondary_window: Type.Optional(Type.Unknown()) });
const chatpassSchema = Type.Object({ windows: Type.Optional(Type.Unknown()) });

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

function amount(value: Static<typeof amountSchema> | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new SubscriptionUsageError("OpenAI returned an unrecognized usage response.");
  return number;
}

function normalizeWindow(window: Static<typeof windowSchema>, limitName: string, meteredFeature: string | null, kind: "primary" | "secondary"): SubscriptionUsage["windows"][number] {
  return { limitName, meteredFeature, kind, usedPercent: window.used_percent, durationSeconds: window.limit_window_seconds || null, resetsAt: window.reset_at ? new Date(window.reset_at * 1000).toISOString() : null };
}

/** Additive categories must not discard valid headline windows or valid siblings. */
function additionalWindows(raw: Static<typeof additionalWindowsSchema> | null | undefined, limitName: string, meteredFeature: string | null): SubscriptionUsage["windows"] {
  if (!raw) return [];
  return (["primary", "secondary"] as const).flatMap((kind) => {
    const window = raw[`${kind}_window`];
    return Value.Check(windowSchema, window) ? [normalizeWindow(window, limitName, meteredFeature, kind)] : [];
  });
}

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
  return [{ periodBasis: "calendar-month-estimate", limitName: "Monthly credits", meteredFeature: "credits", kind: "primary", usedPercent: Math.max(0, usedPercent), durationSeconds: monthlyDurationSeconds(reset), resetsAt: reset?.toISOString() ?? null }];
}

function normalizeUsage(payload: Static<typeof payloadSchema>): SubscriptionUsage {
  if (!Object.keys(payload).some((key) => ["plan_type", "rate_limit", "credits", "code_review_rate_limit", "additional_rate_limits", "individual_limit", "individualLimit", "spend_control", "spendControl", "chatpass", "rate_limit_reset_credits"].includes(key))) throw new SubscriptionUsageError("OpenAI returned an unrecognized usage response.");
  const limits = payload.rate_limit;
  const additional = (Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : []).flatMap((entry) => {
    if (!Value.Check(additionalLimitSchema, entry) || !Value.Check(additionalWindowsSchema, entry.rate_limit)) return [];
    return additionalWindows(entry.rate_limit, entry.limit_name ?? entry.metered_feature ?? "Additional allowance", entry.metered_feature ?? null);
  });
  const review = Value.Check(additionalWindowsSchema, payload.code_review_rate_limit) ? additionalWindows(payload.code_review_rate_limit, "Code review", "code_review") : [];
  const chatpass = Value.Check(chatpassSchema, payload.chatpass) && Array.isArray(payload.chatpass.windows) ? payload.chatpass.windows.filter((window) => Value.Check(windowSchema, window)) : [];
  const usage: SubscriptionUsage = {
    plan: payload.plan_type ?? null,
    checkedAt: new Date().toISOString(),
    allowed: limits?.allowed ?? null,
    limitReached: limits?.limit_reached ?? null,
    windows: additionalWindows(limits, "Codex", null).concat(review).concat(additional).concat(chatpass.map((window) => normalizeWindow(window, "Chatpass", "chatpass", "primary"))),
  };
  const spendControl = payload.spend_control ?? payload.spendControl;
  usage.windows.push(...creditLimitWindow(payload.individual_limit ?? payload.individualLimit ?? limits?.individual_limit ?? limits?.individualLimit ?? spendControl?.individual_limit ?? spendControl?.individualLimit));
  if (payload.credits) {
    amount(payload.credits.balance); // Validate numeric strings too, including overflow.
    usage.credits = {
      unlimited: payload.credits.unlimited ?? false,
      balance: payload.credits.balance === null || payload.credits.balance === undefined ? null : String(payload.credits.balance).trim(),
    };
  }
  if (payload.rate_limit_reset_credits) usage.resets = {
    available: payload.rate_limit_reset_credits.available_count,
  };
  return usage;
}
