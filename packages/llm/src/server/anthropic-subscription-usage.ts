import { Type } from "typebox";
import { Value } from "typebox/value";
import { readSubscriptionUsageJson, requestSubscriptionUsage, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";
type UsageWindow = SubscriptionUsage["windows"][number];

const accountWindowSchema = Type.Object({
  utilization: Type.Number({ minimum: 0, maximum: 100 }),
  resets_at: Type.Union([Type.String(), Type.Null()]),
});
const unrecognizedHeaders = () => new SubscriptionUsageError("Anthropic returned unrecognized rate limit headers.");
const unrecognizedAccountUsageMessage = "Anthropic returned an unrecognized usage response.";
const unrecognizedAccountUsage = () => new SubscriptionUsageError(unrecognizedAccountUsageMessage);
const unitSeconds = new Map([["h", 3600], ["hour", 3600], ["d", 86400], ["day", 86400]]);
const numberWords = new Map(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].map((word, index) => [word, index + 1]));

/** Anthropic names each window by its length and, for a metered feature, a suffix:
 * "5h" or "7d_opus" in headers, "five_hour" or "seven_day_opus" from the account
 * endpoint. The shortest reported window is the primary one. Windows whose names
 * don't state a length can't be paced, so they are left out. */
function namedWindows(reported: Array<{ count: number; unit: string; feature: string | undefined; usedPercent: number; resetsAt: string | null }>): UsageWindow[] {
  const windows = reported.map(({ count, unit, feature, usedPercent, resetsAt }) => ({
    limitName: feature ? feature.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase()) : "Claude",
    meteredFeature: feature ?? null,
    usedPercent,
    durationSeconds: count * unitSeconds.get(unit)!,
    resetsAt,
  }));
  const shortest = Math.min(...windows.map((window) => window.durationSeconds));
  return windows.map((window) => ({ ...window, kind: window.durationSeconds === shortest ? "primary" : "secondary" }));
}

async function requestAnthropic(url: string, accessToken: string, init: { method?: string; headers?: Record<string, string>; body?: string }, fetcher: Fetcher): Promise<Response> {
  const headers = { ...init.headers, Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" };
  return await requestSubscriptionUsage(url, { ...init, headers }, "Could not reach Anthropic to check subscription usage. Try again.", fetcher);
}

function anthropicHttpError(response: Response): SubscriptionUsageError {
  if (response.status === 401) return new SubscriptionUsageError("Anthropic rejected the credentials. Reconnect Anthropic.");
  if (response.status === 403) return new SubscriptionUsageError("Anthropic denied subscription usage access (HTTP 403). Reconnect Anthropic with subscription OAuth sign-in.");
  const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
  return new SubscriptionUsageError(`Anthropic usage is unavailable (HTTP ${response.status}). Try again later.`, Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null);
}

/** Claude's OAuth account endpoint. Not a public, versioned API, and heavily rate limited
 * (429 with an hour-long retry-after), so it only adds windows the headers lack.
 * Entries without a length in their name, such as monetary extra_usage, aren't windows. */
export async function fetchAnthropicAccountUsage(accessToken: string, fetcher: Fetcher = fetch): Promise<UsageWindow[]> {
  const response = await requestAnthropic("https://api.anthropic.com/api/oauth/usage", accessToken, {}, fetcher);
  if (!response.ok) throw anthropicHttpError(response);
  const payload = await readSubscriptionUsageJson(response, Type.Record(Type.String(), Type.Unknown()), {
    invalid: "Anthropic returned an invalid usage response.",
    unrecognized: unrecognizedAccountUsageMessage,
  });
  return namedWindows(Object.entries(payload).flatMap(([key, window]) => {
    const name = key.match(/^([a-z]+)_(hour|day)(?:_(.+))?$/);
    const count = name && numberWords.get(name[1]!);
    // A null bucket is one the account doesn't have.
    if (!count || window === null) return [];
    if (!Value.Check(accountWindowSchema, window)) throw unrecognizedAccountUsage();
    // A reported bucket is still meaningful without reset timing.
    const reset = window.resets_at === null ? null : new Date(window.resets_at);
    if (reset !== null && !Number.isFinite(reset.getTime())) throw unrecognizedAccountUsage();
    return [{ count, unit: name[2]!, feature: name[3], usedPercent: window.utilization, resetsAt: reset?.toISOString() ?? null }];
  }));
}

/** Subscription OAuth responses from /v1/messages carry the account's unified limits.
 * Returns null when the response carries none, such as API-key traffic. */
export function anthropicUsageFromHeaders(headers: Headers, checkedAt: Date): SubscriptionUsage | null {
  const status = headers.get("anthropic-ratelimit-unified-status");
  if (status === null) return null;
  const windows = namedWindows([...headers].flatMap(([header, utilization]) => {
    const name = header.match(/^anthropic-ratelimit-unified-(\d+)([hd])(?:[-_](.+))?-utilization$/);
    if (!name) return [];
    // A fraction of the allowance; it can pass 1 once the allowance is exhausted.
    const used = Number(utilization);
    if (utilization.trim() === "" || !Number.isFinite(used) || used < 0) throw unrecognizedHeaders();
    const resetHeader = headers.get(header.replace(/-utilization$/, "-reset"));
    const reset = resetHeader === null ? null : Number(resetHeader);
    if (reset !== null && (resetHeader!.trim() === "" || !Number.isInteger(reset) || reset <= 0)) throw unrecognizedHeaders();
    return [{ count: Number(name[1]), unit: name[2]!, feature: name[3], usedPercent: used * 100, resetsAt: reset === null ? null : new Date(reset * 1000).toISOString() }];
  }));
  return { plan: null, checkedAt: checkedAt.toISOString(), allowed: status !== "rejected", limitReached: status === "rejected", windows };
}

/** The cheapest request that returns the unified limit headers; count_tokens does not. */
export async function probeAnthropicSubscriptionUsage(accessToken: string, model: string, fetcher: Fetcher = fetch): Promise<SubscriptionUsage> {
  const response = await requestAnthropic("https://api.anthropic.com/v1/messages", accessToken, {
    method: "POST",
    headers: { "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "." }],
    }),
  }, fetcher);
  await response.body?.cancel();
  // Limited responses still carry the headers, and say the limit was reached.
  const usage = anthropicUsageFromHeaders(response.headers, new Date());
  if (!usage) throw anthropicHttpError(response);
  return usage;
}

/** Joins callers onto one pending request instead of sending duplicates. */
function singleFlight<Args extends unknown[], Result>(start: (...args: Args) => Promise<Result>) {
  let pending: Promise<Result> | undefined;
  return {
    run(...args: Args): Promise<Result> {
      if (pending) return pending;
      const started = start(...args).finally(() => { if (pending === started) pending = undefined; });
      pending = started;
      return started;
    },
    clear(): void { pending = undefined; },
  };
}

const windowName = (window: UsageWindow) => `${window.durationSeconds} ${window.meteredFeature}`;

/** Usage for this host's connected subscription. Usage only rises with use, and
 * Claude Code traffic through the workspace proxy keeps the snapshot current. Anthropic
 * is asked only on the first read after start or a credential change, when a window
 * has reset, and on an explicit refresh, so an idle Kintsugi stays quiet. */
export function createAnthropicUsageSource(fetcher: Fetcher = fetch, now: () => number = Date.now) {
  let observed: SubscriptionUsage | undefined;
  let accountWindows: UsageWindow[] = [];
  let accountUsageAllowedAt = 0;
  // Discards answers that were requested with a credential since replaced.
  let generation = 0;

  function record(usage: SubscriptionUsage): void {
    if (observed && observed.checkedAt > usage.checkedAt) return;
    observed = usage;
  }

  const probe = singleFlight(async (token: string, model: string) => {
    const started = generation;
    const result = await probeAnthropicSubscriptionUsage(token, model, fetcher);
    const usage = { ...result, checkedAt: new Date(now()).toISOString() };
    if (generation === started) record(usage);
    return usage;
  });

  // Its failures keep the last windows rather than failing the headline limits.
  const accountUsage = singleFlight(async (token: string) => {
    if (now() < accountUsageAllowedAt) return;
    const started = generation;
    try {
      const windows = await fetchAnthropicAccountUsage(token, fetcher);
      if (generation === started) accountWindows = windows;
    } catch (error) {
      if (!(error instanceof SubscriptionUsageError)) throw error;
      if (generation === started) accountUsageAllowedAt = now() + (error.retryAfterSeconds ?? 0) * 1000;
    }
  });

  return {
    /** Record limits from a /v1/messages response made with the connected subscription. */
    observe(headers: Headers): void {
      const usage = anthropicUsageFromHeaders(headers, new Date(now()));
      if (usage) record(usage);
    },
    /** The subscription credential changed; nothing known applies to it. */
    forget(): void {
      generation++;
      observed = undefined;
      probe.clear();
      accountUsage.clear();
      accountWindows = [];
      accountUsageAllowedAt = 0;
    },
    async usage(token: string, options: { model: string; refresh: boolean }): Promise<SubscriptionUsage> {
      let usage = observed;
      const resetPassed = usage?.windows.some((window) => window.resetsAt !== null && new Date(window.resetsAt).getTime() <= now());
      if (options.refresh || !usage || resetPassed) [usage] = await Promise.all([probe.run(token, options.model), accountUsage.run(token)]);
      // Headers are current; the account endpoint only adds windows they lack.
      const reported = new Set(usage.windows.map(windowName));
      return { ...usage, windows: [...usage.windows, ...accountWindows.filter((window) => !reported.has(windowName(window)))] };
    },
  };
}

export const anthropicUsageSource = createAnthropicUsageSource();
