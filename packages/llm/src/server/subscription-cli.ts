import { Type } from "typebox";
import { Value } from "typebox/value";
import { shellQuote } from "@kintsugi/core";
import { registerWorkspaceResponseTransform, registerWorkspaceSubscriptionSecrets } from "@kintsugi/proxy-egress/server";
import { execWorkspaceCommand, listWorkspaces } from "@kintsugi/workspace";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { anthropicUsageSource } from "./anthropic-subscription-usage.ts";
import { SubscriptionUsageError } from "./subscription-usage.ts";
import { recordSubscriptionInference } from "./recent-subscription-activity.ts";
import { requireProviderSubscription, usesProviderSubscription } from "./subscription.ts";
import { codexAccountId } from "./codex-token.ts";

const codexToken = "kintsugi-subscription-codex-access";
const codexAccount = "kintsugi-subscription-codex-account";
const anthropicToken = "kintsugi-subscription-anthropic-access";

export function registerSubscriptionCli(getRuntime: () => Promise<ModelRuntime>): void {
  async function subscriptionToken(provider: string): Promise<string> {
    const auth = await (await getRuntime()).getAuth(provider);
    if (auth?.source !== "OAuth" || !auth.auth.apiKey) throw new Error(`Connect a ${provider} subscription in Kintsugi to use this CLI.`);
    return auth.auth.apiKey;
  }
  async function usesConnectedSubscription(request: Request, provider: "anthropic" | "openai-codex"): Promise<boolean> {
    const auth = await (await getRuntime()).getAuth(provider);
    return auth?.source === "OAuth" && !!auth.auth.apiKey && request.headers.get("authorization") === `Bearer ${auth.auth.apiKey}`;
  }
  registerWorkspaceResponseTransform("codex-accounts-check", async (response, request) => {
    if (new URL(request.url).hostname !== "chatgpt.com" || !["/api/codex/accounts/check", "/backend-api/wham/accounts/check"].includes(new URL(request.url).pathname) || !response.ok) return response;
    const accountId = codexAccountId(await subscriptionToken("openai-codex"));
    return maskCodexAccountDiscovery(response, accountId);
  });
  registerWorkspaceResponseTransform("codex-subscription-activity", async (response, request) => {
    const url = new URL(request.url);
    const inference = (url.hostname === "chatgpt.com" && /^\/(?:backend-api|api)\/codex\/responses(?:\/|$)/.test(url.pathname))
      || (url.hostname === "api.openai.com" && url.pathname === "/v1/responses");
    if (!inference || request.method !== "POST" || !response.ok) return response;
    if (await usesConnectedSubscription(request, "openai-codex")) recordSubscriptionInference("openai-codex");
    return response;
  });
  // Claude Code responses carry the subscription's limits; keeping them spares the
  // usage view from asking Anthropic separately while agents are working.
  registerWorkspaceResponseTransform("anthropic-subscription-usage", async (response, request) => {
    const url = new URL(request.url);
    if (url.hostname !== "api.anthropic.com") return response;
    const inference = url.pathname === "/v1/messages" && request.method === "POST";
    const hasLimits = response.headers.has("anthropic-ratelimit-unified-status");
    if (!inference && !hasLimits) return response;
    // Only Kintsugi's connected subscription, not a login made inside the workspace.
    if (!(await usesConnectedSubscription(request, "anthropic"))) return response;
    try {
      if (hasLimits) anthropicUsageSource.observe(response.headers);
      if (inference && response.ok) recordSubscriptionInference("anthropic");
    } catch (error) {
      // Usage is a side channel; never fail Claude Code's request over it.
      if (!(error instanceof SubscriptionUsageError)) throw error;
      console.warn(`[usage] ${error.message}`);
    }
    return response;
  });
  registerWorkspaceSubscriptionSecrets({
    codexSubscription: { placeholder: codexToken, hosts: ["chatgpt.com", "api.openai.com"], value: "", resolve: () => subscriptionToken("openai-codex") },
    codexAccount: { placeholder: codexAccount, hosts: ["chatgpt.com", "api.openai.com"], value: "", resolve: async () => {
      const token = await subscriptionToken("openai-codex");
      return codexAccountId(token);
    } },
    anthropicSubscription: { placeholder: anthropicToken, hosts: ["api.anthropic.com"], value: "", resolve: () => subscriptionToken("anthropic") },
  });
}

/** Codex 0.154+ checks that its selected account appears in accounts/check.
 * Keep the real account ID in the host: translate that endpoint's selected ID
 * back to the placeholder in the response, just as requests translate it out.
 */
export async function maskCodexAccountDiscovery(response: Response, accountId: string): Promise<Response> {
  const payload: unknown = await response.clone().json().catch(() => null);
  if (!Value.Check(Type.Object({
    accounts: Type.Array(Type.Object({ id: Type.String() })),
    account_ordering: Type.Optional(Type.Array(Type.String())),
    default_account_id: Type.Optional(Type.String()),
  }), payload)) return response;
  for (const account of payload.accounts) if (account.id === accountId) account.id = codexAccount;
  if (payload.account_ordering) payload.account_ordering = payload.account_ordering.map(id => id === accountId ? codexAccount : id);
  if (payload.default_account_id === accountId) payload.default_account_id = codexAccount;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers });
}

// Only placeholders enter the sandbox. Pi owns refresh tokens and refresh serialization.
// Far-future timestamps keep the CLIs from trying to refresh these non-credentials.
export function subscriptionCliFiles(): Array<{ provider: string; path: string; content: string; marker: string }> {
  const idToken = [Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"), Buffer.from(JSON.stringify({
    email: "subscription@kintsugi.local",
    "https://api.openai.com/auth": { chatgpt_account_id: codexAccount },
  })).toString("base64url"), "kintsugi"].join(".");
  return [
    { provider: "openai-codex", path: ".codex/auth.json", marker: codexToken, content: JSON.stringify({
      auth_mode: "chatgpt", OPENAI_API_KEY: null,
      tokens: { id_token: idToken, access_token: codexToken, refresh_token: "", account_id: codexAccount },
      last_refresh: "2099-01-01T00:00:00Z",
    }) },
    { provider: "anthropic", path: ".claude/.credentials.json", marker: anthropicToken, content: JSON.stringify({
      // An empty refresh token means revoked/expired to Claude Code. Null means
      // there is no local refresh credential; Kintsugi owns token refresh instead.
      claudeAiOauth: { accessToken: anthropicToken, refreshToken: null, expiresAt: 4070908800000, scopes: ["user:inference", "user:profile"] },
    }) },
  ];
}

export async function installSubscriptionCli(workspaceId: string, runtime: ModelRuntime): Promise<void> {
  for (const file of subscriptionCliFiles()) {
    const connected = await usesProviderSubscription(runtime, file.provider);
    const path = shellQuote(`/home/agent/${file.path}`);
    const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", `set -eu
umask 077
${connected ? `if [ ! -e ${path} ] || grep -qF ${shellQuote(file.marker)} ${path}; then
  mkdir -p "$(dirname ${path})"
  temporary="$(mktemp ${path}.XXXXXX)"
  printf '%s\\n' ${shellQuote(file.content)} > "$temporary"
  mv "$temporary" ${path}
fi` : `if [ -f ${path} ] && grep -qF ${shellQuote(file.marker)} ${path}; then rm ${path}; fi`}`]);
    if (result.exitCode !== 0) throw new Error(`Could not configure subscription CLI: ${result.stderr}`);
  }
}

/** An app-owned Codex home must use the configured subscription, never a workspace login. */
export async function installCodexSubscriptionAuth(workspaceId: string, codexHome: string, runtime: Pick<ModelRuntime, "listCredentials">): Promise<void> {
  await requireProviderSubscription(runtime, "openai-codex", "Codex");
  const file = subscriptionCliFiles().find(file => file.provider === "openai-codex")!;
  const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", `set -eu\numask 077\nmkdir -p ${shellQuote(codexHome)}\ncat > ${shellQuote(`${codexHome}/auth.json`)}`], { stdin: file.content });
  if (result.exitCode !== 0) throw new Error(`Could not configure Codex subscription: ${result.stderr}`);
}

export async function syncSubscriptionClis(runtime: ModelRuntime): Promise<void> {
  for (const workspace of (await listWorkspaces({ inspectImages: false })).workspaces) {
    if (!workspace.parked) await installSubscriptionCli(workspace.id, runtime);
  }
}
