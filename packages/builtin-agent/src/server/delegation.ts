import type { Message, Models } from "@earendil-works/pi-ai";
import type { Extension, Harness, ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { KintsugiCoreError } from "@kintsugi/core";
import { listWorkspaceAgents, type WorkspaceAgentInfo } from "./agent-store.ts";
import { durableWorkspaceOwner } from "./runtime.ts";
import { isOneShotAgent } from "./durable-workspace.ts";

export interface AgentDelegation {
  create(models: Models, harness: () => Harness): { extension: Extension; models: Models };
  /** The messages a generation request sends, as the extension's request hook prepares them. */
  requestMessages(messages: readonly Message[], conversationId: ConversationId): Message[];
  attributed(entry: EntryRecord): "task" | "message" | undefined;
}

/** One optional native integration, installed before workspace owners open.
 * Execution belongs to the workspace Harness; presentation is passive. */
export let agentDelegation: AgentDelegation | undefined;
export function configureAgentDelegation(delegation: AgentDelegation | undefined): void {
  agentDelegation = delegation;
}

export async function resolveAgent(workspaceId: string, agentId: string): Promise<WorkspaceAgentInfo> {
  const root = (await listWorkspaceAgents(workspaceId)).find((agent) => agent.agentId === agentId);
  if (root) return root;
  // A child agent, such as a subagent or a script's one-shot agent, shares its root's journal.
  const child = (await (await durableWorkspaceOwner(workspaceId)).catalog()).find(record => record.parentId && record.agentId === agentId);
  if (child) return { ...child, workspaceId, path: "", storage: "durable", oneShot: isOneShotAgent(child) };
  throw new KintsugiCoreError("agent_not_found", `Agent not found: ${agentId}`);
}
