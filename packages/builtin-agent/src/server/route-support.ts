import { type KintsugiEventBus } from "@kintsugi/core";
import type { maybeNameAgentFromPrompt } from "./agent-title-suggestion.ts";
import { resolveAgent } from "./delegation.ts";
import { getWorkspaceAgentPresentation, getWorkspaceAgentController } from "./runtime.ts";
import { type WorkspaceAgentInfo } from "./agent-store.ts";

export interface AgentRouteOptions {
  renderPage?: (body: string) => Response;
  events?: KintsugiEventBus;
  getController?: typeof getWorkspaceAgentController;
  getPresentation?: typeof getWorkspaceAgentPresentation;
  knownRequest?: typeof import("./runtime.ts").knownWorkspaceAgentRequest;
  suggestTitleFromPrompt?: typeof maybeNameAgentFromPrompt;
}

export type AgentRouteHandler = (request: Request, url: URL, options: AgentRouteOptions) => Promise<Response | undefined>;

export async function invalidateAgentView(options: AgentRouteOptions, workspaceId: string, agentId: string): Promise<void> {
  await options.events?.emit("workspace_agent_view_invalidated", { workspaceId, agentId });
}

async function resolveAgentPresentation(agent: WorkspaceAgentInfo, options: AgentRouteOptions): ReturnType<typeof getWorkspaceAgentPresentation> {
  return await (options.getPresentation ?? getWorkspaceAgentPresentation)(agent, { events: options.events });
}

export async function requireAgentPresentation(workspaceId: string, agentId: string, options: AgentRouteOptions): ReturnType<typeof getWorkspaceAgentPresentation> {
  return await resolveAgentPresentation(await resolveAgent(workspaceId, agentId), options);
}

export async function resolveAgentController(agent: WorkspaceAgentInfo, options: AgentRouteOptions): ReturnType<typeof getWorkspaceAgentController> {
  return (options.getController ?? getWorkspaceAgentController)(agent, { events: options.events });
}

export async function requireAgentController(workspaceId: string, agentId: string, options: AgentRouteOptions): ReturnType<typeof getWorkspaceAgentController> {
  return resolveAgentController(await resolveAgent(workspaceId, agentId), options);
}
