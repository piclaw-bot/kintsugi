import { Type } from "typebox";
import { fetchSubscriptionUsageJson, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";

const amountSchema = Type.Optional(Type.Object({ val: Type.Optional(Type.Union([Type.Number(), Type.String({ pattern: "^-?\\d+(?:\\.\\d+)?$" })])) }));
const payloadSchema = Type.Object({
  subscriptionTier: Type.Optional(Type.String()),
  config: Type.Object({
    currentPeriod: Type.Optional(Type.Object({ start: Type.Optional(Type.String()), end: Type.Optional(Type.String()) })),
    billingPeriodStart: Type.Optional(Type.String()),
    billingPeriodEnd: Type.Optional(Type.String()),
    // May be absent when the account reports only on-demand counts or billing dates.
    creditUsagePercent: Type.Optional(Type.Number({ minimum: 0 })),
    onDemandCap: amountSchema,
    onDemandUsed: amountSchema,
    subscriptionTier: Type.Optional(Type.String()),
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
  const end = periodEnd === undefined ? Number.NaN : new Date(periodEnd).getTime();
  if (!Number.isFinite(end)) throw new SubscriptionUsageError(messages.unrecognized);
  const start = periodStart === undefined ? Number.NaN : new Date(periodStart).getTime();
  const cap = Number(config.onDemandCap?.val ?? 0);
  const onDemandPercent = cap > 0 && config.onDemandUsed !== undefined ? Number(config.onDemandUsed.val ?? 0) / cap * 100 : undefined;
  const usedPercent = config.creditUsagePercent ?? onDemandPercent;
  if (usedPercent !== undefined && (!Number.isFinite(usedPercent) || usedPercent < 0)) throw new SubscriptionUsageError(messages.unrecognized);
  return {
    plan: config.subscriptionTier ?? payload.subscriptionTier ?? null,
    checkedAt: new Date().toISOString(),
    allowed: null,
    limitReached: usedPercent === undefined ? null : usedPercent >= 100,
    windows: usedPercent === undefined ? [] : [{ limitName: "Grok", meteredFeature: null, kind: "primary", usedPercent: Math.min(100, usedPercent), durationSeconds: Number.isFinite(start) && end > start ? Math.round((end - start) / 1000) : null, resetsAt: new Date(end).toISOString() }],
  };
}
