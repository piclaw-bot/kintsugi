import { createCodemodeWorkerAdmission } from "./codemode-worker-admission.ts";
import { createNativePlanExtension } from "./durable-plan.ts";
import { createNativeAgentIdentityResolver } from "./durable-agent-identity.ts";
import { createHistorySearchTool } from "./history-search.ts";
import { agentDelegation } from "./delegation.ts";
import { durableTiming, type WriteDurableTiming } from "./durable-timing.ts";
import { durableSubscriptionActivity } from "./durable-accounting.ts";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, type AgentChange, type Harness, type HarnessOptions, type ConversationId } from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { createPiModelRuntime } from "@kintsugi/llm/server";
import { workspaceRoot } from "@kintsugi/workspace";
import { createDurableWorkspaceTools } from "./durable-tools.ts";
import { createDurableBashExtension } from "./durable-bash.ts";
import { createWorkspaceCodemodeExtension } from "./durable-codemode.ts";
import { durableJournalInstructions } from "./durable-storage.ts";
import { formatProjectInstructions, loadWorkspaceAgentsFiles } from "@kintsugi/agent/server/workspace-agents-files";
import { loadWorkspaceSkills } from "@kintsugi/agent/server/skills";
import { kintsugiSystemPrompt, prepareAppendedKintsugiInstructions } from "@kintsugi/agent/server/system-prompt";
import { launchComposerThinkingSettings, resolveNewWorkspaceAgentModel } from "@kintsugi/agent/server/model-state";
import type { WorkspaceAgentToolOptions } from "@kintsugi/agent/server/tools";

// Bound live workers across workspaces, including cancelled workers still computing.
const codemodeSandbox = new CodemodeSandbox({
  memoryLimitBytes: 256 * 1024 * 1024,
  acquireWorker: createCodemodeWorkerAdmission(2),
});

/** Workspace-scoped code, including the task definitions needed to recover bash and code mode scripts. */
export function createDurableWorkspaceRegistry(workspaceId: string, models: Pick<Models, "getModel">, options: WorkspaceAgentToolOptions = {}, resolveAgentId?: (conversationId: ConversationId) => Promise<string>) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "kintsugi.workspace-tools", tools: createDurableWorkspaceTools(workspaceId, models, options, resolveAgentId) }));
  registry.install(createDurableBashExtension(workspaceId));
  registry.install(createWorkspaceCodemodeExtension(workspaceId, codemodeSandbox));
  return registry;
}

/** No AgentSession, delegation coordinator, or host-local filesystem environment. */
export async function createDurableHarnessOptions(workspaceId: string, options: WorkspaceAgentToolOptions, writeTiming: WriteDurableTiming, harness: () => Harness): Promise<HarnessOptions> {
  const models = await createPiModelRuntime();
  const registry = createDurableWorkspaceRegistry(workspaceId, models, options, createNativeAgentIdentityResolver(workspaceId, harness));
  registry.install(defineExtension({ name: "kintsugi.history-search", tools: [createHistorySearchTool(workspaceId, harness)] }));
  registry.install(createNativePlanExtension(workspaceId, harness));
  const delegation = agentDelegation?.create(models, harness);
  if (delegation) registry.install(delegation.extension);
  registry.install(durableSubscriptionActivity(models));
  registry.install(durableTiming(writeTiming));
  return {
    models: delegation?.models ?? models,
    registry,
    // Evict unobserved document caches after a minute; storage and provider caches are unchanged.
    settings: { documentRetentionMs: 60_000, compaction: { enabled: true, keepRecentTokens: 6000 } },
  };
}

const resourceLoaders = {
  agents: loadWorkspaceAgentsFiles,
  skills: loadWorkspaceSkills,
  model: resolveNewWorkspaceAgentModel,
  thinking: launchComposerThinkingSettings,
};

/**
 * Prepare outside the journal commit; pass the result to workspace.agent().
 * The resulting prompt/model are committed with creation, not rebuilt on recovery
 * from potentially changed workspace files or the host's current model default.
 * Existing conversations keep their settings; explicit refresh uses configure().
 */
export async function prepareDurableAgent(
  workspaceId: string,
  agentId: string,
  options: WorkspaceAgentToolOptions = {},
  initial: Pick<AgentChange, "model" | "thinkingLevel"> = {},
  load: typeof resourceLoaders = resourceLoaders,
): Promise<AgentChange> {
  const [agents, skills, model, appended] = await Promise.all([
    load.agents(workspaceId),
    load.skills(workspaceId),
    initial.model !== undefined ? Promise.resolve(undefined) : load.model(),
    prepareAppendedKintsugiInstructions(options.events, workspaceId, agentId),
  ]);
  const selectedModel = initial.model !== undefined ? initial.model : model ? { provider: model.provider, modelId: model.id } : undefined;
  const thinking = initial.thinkingLevel !== undefined ? initial.thinkingLevel
    : (await load.thinking(selectedModel ? { provider: selectedModel.provider, id: selectedModel.modelId } : undefined)).selected;
  const instructions = [
    kintsugiSystemPrompt,
    durableJournalInstructions(workspaceId, agentId),
    ...appended,
    ...agents.map(formatProjectInstructions),
    formatSkillsForPrompt(skills.skills),
    `Current working directory: ${workspaceRoot}`,
  ].filter(Boolean).join("\n\n");
  return {
    cwd: workspaceRoot,
    model: selectedModel,
    thinkingLevel: thinking,
    instructions,
  };
}
