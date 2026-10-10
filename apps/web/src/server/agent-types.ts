import { hasAvailableBuiltinAgentModel } from "@kintsugi/builtin-agent/server";
import { kintsugiDataPath, getKintsugiRuntimeContext, invalidArguments, readTextIfExists, writeJsonAtomic, type KintsugiEventBus } from "@kintsugi/core";
import { createPiModelRuntime, usesProviderSubscription } from "@kintsugi/llm/server";
import type { WorkspaceAgentType } from "@kintsugi/shared";
import { workspaceModules } from "./workspace-modules.generated.ts";

export function registeredAgentTypes(): readonly WorkspaceAgentType[] { return workspaceModules.flatMap((module) => module.agentType ? [module.agentType] : []); }

export function getAgentType(id: string): WorkspaceAgentType {
  const agentType = registeredAgentTypes().find((agentType) => agentType.id === id);
  if (!agentType) throw invalidArguments(`Unknown agent type: ${id}`);
  return agentType;
}

function preferencePath() {
  return kintsugiDataPath(getKintsugiRuntimeContext(), "default-agent-type.json");
}

export async function defaultAgentType(): Promise<WorkspaceAgentType> {
  const text = await readTextIfExists(preferencePath())
    ?? await readTextIfExists(kintsugiDataPath(getKintsugiRuntimeContext(), "default-agent-provider.json"));
  const id: unknown = text === undefined ? undefined : JSON.parse(text);
  const agentType = registeredAgentTypes().find((agentType) => agentType.id === id) ?? getAgentType("builtin");
  // Anthropic subscriptions work only in Claude Code; without another usable model, the built-in agent could not start.
  if (agentType.id === "builtin" && !await hasAvailableBuiltinAgentModel() && await usesProviderSubscription(await createPiModelRuntime(), "anthropic")) return getAgentType("claude");
  return agentType;
}

export async function rememberAgentType(id: string, events?: KintsugiEventBus): Promise<void> {
  getAgentType(id);
  await writeJsonAtomic(preferencePath(), id);
  await events?.emit("agent_type_default_changed", { agentTypeId: id });
}

export async function orderedAgentTypes(): Promise<readonly WorkspaceAgentType[]> {
  const preferred = await defaultAgentType();
  return [preferred, ...registeredAgentTypes().filter((agentType) => agentType.id !== preferred.id)];
}
