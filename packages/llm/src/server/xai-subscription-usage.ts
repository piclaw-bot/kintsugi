import { Type } from "typebox";
import { Value } from "typebox/value";
import { fetchSubscriptionUsageJson, parseSubscriptionUsageDate, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";

const numberSchema = Type.Union([Type.Number(), Type.String({ pattern: "^-?\\d+(?:\\.\\d+)?$" })]);
const amountSchema = Type.Optional(Type.Union([Type.Object({ val: Type.Optional(numberSchema) }), Type.Null()]));
const nullableString = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const walletSchema = Type.Object({ val: Type.Optional(numberSchema) });
const payloadSchema = Type.Object({
  subscriptionTier: nullableString,
  config: Type.Object({
    currentPeriod: Type.Optional(Type.Union([Type.Object({ start: nullableString, end: nullableString }), Type.Null()])),
    billingPeriodStart: nullableString,
    billingPeriodEnd: nullableString,
    creditUsagePercent: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    onDemandCap: amountSchema,
    onDemandUsed: amountSchema,
    subscriptionTier: nullableString,
    // Optional wallet failures must not discard a valid allowance response.
    prepaidBalance: Type.Optional(Type.Unknown()),
  }),
});

/** The Grok CLI's own usage panel reads this billing proxy, as does CodexBar. Not a public, versioned API.
 * Every Grok product draws from one allowance per period, so it is a single window. */
export async function fetchXaiSubscriptionUsage(accessToken: string, fetcher: Fetcher = fetch): Promise<SubscriptionUsage> {
  const messages = subscriptionUsageMessages("xAI");
  const payload = await fetchSubscriptionUsageJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    headers: { Authorization: `Bearer ${accessToken}`, "X-XAI-Token-Auth": "xai-grok-cli", Accept: "application/json" },
  }, payloadSchema, messages, fetcher);
  const { config } = payload;
  // Never pair the start of one billing period with the end of another.
  const [periodStart, periodEnd] = config.currentPeriod?.end ? [config.currentPeriod.start, config.currentPeriod.end] : [config.billingPeriodStart, config.billingPeriodEnd];
  const end = parseSubscriptionUsageDate(periodEnd, messages.unrecognized);
  const start = parseSubscriptionUsageDate(periodStart, messages.unrecognized);
  const cap = config.onDemandCap == null ? undefined : Number(config.onDemandCap.val ?? 0);
  // Only an existing empty amount means zero (proto3 omits its zero scalar). Absence means unknown.
  const used = config.onDemandUsed == null ? undefined : Number(config.onDemandUsed.val ?? 0);
  if ([cap, used].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) throw new SubscriptionUsageError(messages.unrecognized);
  const onDemandPercent = cap !== undefined && cap > 0 && used !== undefined ? used / cap * 100 : undefined;
  const usedPercent = config.creditUsagePercent ?? onDemandPercent;
  if (usedPercent !== undefined && !Number.isFinite(usedPercent)) throw new SubscriptionUsageError(messages.unrecognized);
  // The official wallet contract is USD cents, not credits or whole dollars.
  const cents = Value.Check(walletSchema, config.prepaidBalance) ? Number(config.prepaidBalance.val ?? 0) : undefined;
  const walletUSD = cents !== undefined && Number.isSafeInteger(cents) && cents >= 0 ? cents / 100 : undefined;
  if (usedPercent === undefined && end === null && walletUSD === undefined) throw new SubscriptionUsageError(messages.unrecognized);
  const duration = start !== null && end !== null && end > start ? Math.round((end.getTime() - start.getTime()) / 1000) : null;
  const usage: SubscriptionUsage = {
    plan: config.subscriptionTier ?? payload.subscriptionTier ?? null,
    checkedAt: new Date().toISOString(),
    allowed: null,
    limitReached: usedPercent === undefined ? null : usedPercent >= 100,
    windows: usedPercent === undefined ? [] : [{ limitName: "Grok", meteredFeature: null, kind: "primary", usedPercent, durationSeconds: duration !== null && duration > 0 ? duration : null, resetsAt: end?.toISOString() ?? null }],
  };
  if (walletUSD !== undefined) usage.balance = { currency: "USD", available: walletUSD, monthSpend: null };
  return usage;
}
