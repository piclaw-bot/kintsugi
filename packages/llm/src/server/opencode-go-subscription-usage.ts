import { Type } from "typebox";
import { requestSubscriptionUsage, readSubscriptionUsageJson, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";

const windowSchema = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("rate-limited")]),
  percent: Type.Number({ minimum: 0, maximum: 100 }),
  resetsAt: Type.String(),
});
const payloadSchema = Type.Object({ usage: Type.Object({ rolling: windowSchema, weekly: windowSchema, monthly: windowSchema }) });

/** Go authenticates subscription usage with the same API key used for inference. */
export async function fetchOpenCodeGoSubscriptionUsage(apiKey: string, fetcher: Fetcher = fetch): Promise<SubscriptionUsage> {
  const messages = subscriptionUsageMessages("OpenCode Go");
  const response = await requestSubscriptionUsage("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  }, messages.unreachable, fetcher);
  if (response.status === 401) throw new SubscriptionUsageError(messages.rejected);
  if (response.status === 403) throw new SubscriptionUsageError("This API key doesn’t have an OpenCode Go subscription. Check your subscription in OpenCode Console.");
  if (!response.ok) throw new SubscriptionUsageError(messages.unavailable(response.status));
  const { usage } = await readSubscriptionUsageJson(response, payloadSchema, messages);
  const windows = ([
    ["rolling", "5-hour", 5 * 3600],
    ["weekly", "Weekly", 7 * 86400],
  ] as const).map(([key, limitName, durationSeconds]) => {
    const window = usage[key];
    const reset = new Date(window.resetsAt).getTime();
    if (!Number.isFinite(reset)) throw new SubscriptionUsageError(messages.unrecognized);
    return { limitName, meteredFeature: null, kind: key === "rolling" ? "primary" as const : "secondary" as const, usedPercent: window.percent, durationSeconds, resetsAt: new Date(reset).toISOString() };
  });
  // Monthly still affects availability, but isn't shown without a known period length.
  const limitReached = Object.values(usage).some(window => window.status === "rate-limited");
  return { plan: null, checkedAt: new Date().toISOString(), allowed: !limitReached, limitReached, windows };
}
