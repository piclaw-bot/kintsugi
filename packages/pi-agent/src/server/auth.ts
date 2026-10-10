import { KintsugiCoreError } from "@kintsugi/core";
import { hasAvailableEnabledModel } from "@kintsugi/llm/server";

export function piModelSetupRequired(): KintsugiCoreError {
  return new KintsugiCoreError("agent_setup_required", "Connect a provider and choose an available enabled model before creating a Pi agent.", { setupUrl: "/models?focus=models" });
}

export async function requirePiModels(): Promise<void> {
  if (!await hasAvailableEnabledModel()) throw piModelSetupRequired();
}
