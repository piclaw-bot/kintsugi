import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentEnabledModels } from "./model-preferences.ts";
import { createPiModelRuntime, modelUnavailableReason, providerAvailability, modelThinkingLevels, parseModelRef, usesProviderSubscription, getAgentModelThinkingLevel, type ModelRef } from "@kintsugi/llm/server";

export interface AgentModelOptionView {
  provider: string;
  id: string;
  name: string;
  selected: boolean;
  available: boolean;
  unavailableReason?: string;
}

export function selectAvailableEnabledModel(models: readonly AgentModelOptionView[], requested?: ModelRef): ModelRef | undefined {
  const selected = requested
    ? models.find((model) => model.available && model.provider === requested.provider && model.id === requested.id)
    : undefined;
  const fallback = selected ?? models.find((model) => model.available && model.selected) ?? models.find((model) => model.available);
  return fallback ? { provider: fallback.provider, id: fallback.id } : undefined;
}

export async function resolveNewWorkspaceAgentModel(selectedModel?: string): Promise<ModelRef | undefined> {
  const requested = selectedModel ? parseModelRef(selectedModel) : undefined;
  return selectAvailableEnabledModel(await enabledModelOptionViews(), requested);
}

/** Omit current to select the saved default; null represents a session without a model. */
export async function enabledModelOptionViews(current?: ModelRef | null, runtime?: Pick<Awaited<ReturnType<typeof createPiModelRuntime>>, "getAvailable" | "checkAuth" | "getModel" | "listCredentials">): Promise<AgentModelOptionView[]> {
  runtime ??= await createPiModelRuntime();
  // Anthropic permits Claude subscriptions only in Claude Code.
  const hiddenProvider = await usesProviderSubscription(runtime, "anthropic") ? "anthropic" : undefined;
  const models = (await getAgentEnabledModels()).filter((model) => model.provider !== hiddenProvider);
  const availability = await providerAvailability(runtime, models.map((model) => model.provider));
  return models.map((model) => {
    const unavailableReason = modelUnavailableReason(availability.get(model.provider)!, model, runtime);
    return {
      provider: model.provider,
      id: model.id,
      name: model.label,
      selected: current === undefined ? Boolean(model.active) : current !== null && current.provider === model.provider && current.id === model.id,
      available: !unavailableReason,
      unavailableReason,
    };
  });
}

export async function launchComposerThinkingSettings(model: ModelRef | undefined): Promise<{ levels: string[]; selected?: ModelThinkingLevel }> {
  if (!model) return { levels: [] };
  const levels = await modelThinkingLevels(model);
  const remembered = await getAgentModelThinkingLevel("builtin", { provider: model.provider, id: model.id });
  return { levels, selected: levels.find((level) => level === remembered) ?? (levels.includes("medium") ? "medium" : levels[0]) };
}
