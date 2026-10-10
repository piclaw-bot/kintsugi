import { KintsugiCoreError } from "@kintsugi/core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const anthropicSubscriptionNotice = {
  title: "You can use your Anthropic subscription in Kintsugi.",
  message: "Make sure to select Claude Code as agent. Anthropic does not allow you to use our other agents with their subscription.",
};
/** Short form for pickers and errors where a model cannot use the subscription. */
export const anthropicSubscriptionUnavailableReason = "Anthropic does not allow you to use our other agents with their subscription. Select Claude Code as agent.";

/** Pi stores one credential per provider (see accounts.ts), so an OAuth credential means the provider is connected only through a subscription. */
export async function usesProviderSubscription(runtime: Pick<ModelRuntime, "listCredentials">, provider: string): Promise<boolean> {
  return (await runtime.listCredentials()).some((credential) => credential.providerId === provider && credential.type === "oauth");
}

/** Subscription CLI agents cannot run on an API key; send the user to that provider's subscription setup. */
export async function requireProviderSubscription(runtime: Pick<ModelRuntime, "listCredentials">, provider: string, agentLabel: string): Promise<void> {
  if (!await usesProviderSubscription(runtime, provider)) {
    throw new KintsugiCoreError("agent_setup_required", `Connect a ${agentLabel} subscription before creating a ${agentLabel} agent.`, { setupUrl: `/models?connect=${provider}` });
  }
}
