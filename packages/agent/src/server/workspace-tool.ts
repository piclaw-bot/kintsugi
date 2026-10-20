import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

export interface WorkspaceToolIdentity { readonly agentId: string }

/** Workspace capabilities do not depend on AgentSession or its extension context. */
export type WorkspaceTool<TParams extends TSchema = TSchema, TDetails = unknown> = Pick<
  ToolDefinition<TParams, TDetails>,
  "name" | "label" | "description" | "parameters" | "prepareArguments" | "executionMode"
> & {
  /** The host must supply a verified calling identity, never a model argument. */
  requiresAgentIdentity?: boolean;
  execute(
    callId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: Parameters<ToolDefinition<TParams, TDetails>["execute"]>[3],
    identity?: WorkspaceToolIdentity,
  ): ReturnType<ToolDefinition<TParams, TDetails>["execute"]>;
};

export function defineWorkspaceTool<TParams extends TSchema, TDetails = unknown>(tool: WorkspaceTool<TParams, TDetails>): WorkspaceTool<TParams, TDetails> {
  return tool;
}
