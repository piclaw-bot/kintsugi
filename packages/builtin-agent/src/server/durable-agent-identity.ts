import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { WorkspaceAgents } from "./durable-workspace.ts";

/** Resolve committed ownership for the current conversation, including retained forks. */
export function createNativeAgentIdentityResolver(workspaceId: string, harness: () => Harness) {
  return async (conversationId: ConversationId): Promise<string> => {
    const catalog = await harness().snapshot(WorkspaceAgents, BACKGROUND_CONTEXT);
    if (catalog?.workspaceId !== workspaceId) throw new Error("Agent workspace identity mismatch");
    const record = catalog.agents.find(record => (record.branches ?? [record.durableId]).includes(conversationId));
    if (!record || record.readOnly) throw new Error("No editable Agent owns this conversation");
    return record.agentId;
  };
}
