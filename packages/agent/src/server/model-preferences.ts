import { getEnabledModels, getAgentModelPreference, setAgentModelPreference } from "@kintsugi/llm/server";

export async function getAgentEnabledModels() {
  const [models, active] = await Promise.all([getEnabledModels(), getAgentModelPreference("builtin")]);
  const selected = models.find((model) => model.provider === active?.provider && model.id === active?.id) ?? models[0];
  return models.map((model) => ({ ...model, active: model === selected }));
}

export async function reconcileAgentModelPreferences(): Promise<void> {
  const [models, active] = await Promise.all([getEnabledModels(), getAgentModelPreference("builtin")]);
  if (models.some((model) => model.provider === active?.provider && model.id === active?.id)) return;
  await setAgentModelPreference("builtin", models[0]);
}
