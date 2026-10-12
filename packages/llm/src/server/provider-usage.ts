import { ModelsError } from "@earendil-works/pi-ai";
import { SubscriptionUsageError, type SubscriptionUsage } from "./subscription-usage.ts";
import { anthropicUsageSource } from "./anthropic-subscription-usage.ts";
import { usageWindowTiming, type PacedUsageWindow } from "./usage-window.ts";
import { fetchCodexSubscriptionUsage } from "./codex-subscription-usage.ts";
import { fetchXaiSubscriptionUsage } from "./xai-subscription-usage.ts";
import { fetchGitHubCopilotSubscriptionUsage } from "./github-copilot-subscription-usage.ts";
import { fetchRadiusUsage } from "./radius-usage.ts";
import { cheapestProviderModel, createPiModelRuntime, readGitHubCopilotUsageToken } from "./pi-config-models.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Only providers with implemented subscription adapters appear in the overview.
// Radius reports a credit balance without allowance windows, so it never drives the usage button.
export const supportedUsageProviders = [{ id: "anthropic", label: "Anthropic" }, { id: "openai-codex", label: "ChatGPT / Codex" }, { id: "xai", label: "xAI" }, { id: "radius", label: "Radius" }, { id: "github-copilot", label: "GitHub Copilot" }] as const;
export type UsageProvider = typeof supportedUsageProviders[number];
type UsageRequest = { runtime: ModelRuntime; refresh: boolean };
const subscriptionAdapters = {
  // Codex reports usage cheaply on every request, so it is always current.
  "openai-codex": (token) => fetchCodexSubscriptionUsage(token),
  xai: (token) => fetchXaiSubscriptionUsage(token),
  radius: (token) => fetchRadiusUsage(token),
  anthropic: (token, { runtime, refresh }) => {
    const model = cheapestProviderModel(runtime, "anthropic");
    if (!model) throw new SubscriptionUsageError("Anthropic has no available model to check usage. Enable a subscription model or reconnect Anthropic.");
    return anthropicUsageSource.usage(token, { model: model.id, refresh });
  },
} satisfies Record<Exclude<UsageProvider["id"], "github-copilot">, (token: string, request: UsageRequest) => Promise<SubscriptionUsage>>;

// Settings loads limits and rings concurrently. Share only in-flight requests with the same credential;
// there is no snapshot TTL, and changing credentials never reuses a previous account's pending response.
const pendingUsage = new Map<string, Promise<SubscriptionUsage>>();
function sharedUsage(provider: UsageProvider, token: string, refresh: boolean, fetchUsage: () => Promise<SubscriptionUsage>): Promise<SubscriptionUsage> {
  const key = JSON.stringify([provider.id, token, refresh]);
  const pending = pendingUsage.get(key);
  if (pending) return pending;
  const request = fetchUsage().finally(() => { if (pendingUsage.get(key) === request) pendingUsage.delete(key); });
  pendingUsage.set(key, request);
  return request;
}

/** Frames for one provider's usage; the scope keeps two lists of the same providers on one page apart. */
export function providerUsageFrameId(view: "rings" | "limits", provider: string, scope: string): string {
  return `usage_provider_${view}_${scope}_${provider}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export interface ProviderUsageOverview {
  provider: UsageProvider;
  connected: boolean;
  reported: SubscriptionUsage | null;
  error: string | null;
  /** Pacing advances with the clock even when consumption is an older observed snapshot. */
  timingAt: string;
  windows: PacedUsageWindow[];
}

export async function connectedUsageProviders(): Promise<UsageProvider[]> {
  const runtime = await createPiModelRuntime();
  return supportedUsageProviders.filter((provider) => runtime.getProviderAuthStatus(provider.id).configured);
}

/** `refresh` asks the provider now instead of reusing what Kintsugi already knows. */
export async function getProviderUsageOverview(provider: UsageProvider, options: { refresh?: boolean } = {}): Promise<ProviderUsageOverview> {
  let reported: SubscriptionUsage | null = null;
  let error: string | null = null;
  const runtime = await createPiModelRuntime();
  const refresh = options.refresh ?? false;
  const connected = runtime.getProviderAuthStatus(provider.id).configured;
  if (connected) {
    try {
      if (provider.id === "github-copilot") {
        // Usage needs GitHub's stored OAuth token, not an inference token. Resolving the latter first
        // adds an unrelated network dependency and can block a perfectly valid account usage check.
        const token = await readGitHubCopilotUsageToken();
        if (!token) throw new SubscriptionUsageError("GitHub Copilot credentials are unavailable. Reconnect GitHub Copilot.");
        reported = await sharedUsage(provider, token, refresh, () => fetchGitHubCopilotSubscriptionUsage(token));
      } else {
        // Pi owns credential storage and serialized OAuth refresh for subscriptions.
        const auth = await runtime.getAuth(provider.id, { signal: AbortSignal.timeout(10_000) });
        if (!auth?.auth.apiKey) throw new SubscriptionUsageError(`${provider.label} credentials are unavailable. Reconnect ${provider.label}.`);
        if (auth.source !== "OAuth") throw new SubscriptionUsageError(`${provider.label} subscription usage requires OAuth sign-in, not an API key. Reconnect ${provider.label} with your subscription.`);
        const adapter = subscriptionAdapters[provider.id];
        const token = auth.auth.apiKey;
        reported = await sharedUsage(provider, token, refresh, () => adapter(token, { runtime, refresh }));
      }
    } catch (cause) {
      if (cause instanceof ModelsError && cause.code === "oauth") {
        error = `${provider.label} sign-in could not be refreshed. Try again or reconnect ${provider.label}.`;
      } else if (cause instanceof SubscriptionUsageError) {
        error = cause.message;
      } else {
        throw cause;
      }
    }
  }
  const timingAt = new Date();
  const windows = reported ? reported.windows.map((window) => ({
    reported: window,
    timing: usageWindowTiming(window, timingAt),
  })) : [];
  return { provider, connected, reported, error, timingAt: timingAt.toISOString(), windows };
}
