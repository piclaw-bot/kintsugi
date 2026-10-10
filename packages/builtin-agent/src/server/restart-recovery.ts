import type { KintsugiEventBus } from "@kintsugi/core";
import { durableWorkspaceOwner } from "./runtime.ts";
import { allowWorkspaceAgentResume } from "./runtime.ts";
import { listWorkspaceAgents } from "./agent-store.ts";

/** Legacy transcripts are read-only. Resume committed native tasks, never synthetic input. */
export async function resumeInterruptedAgentSessions(workspaces: readonly { id: string; parked: boolean }[], events: KintsugiEventBus): Promise<void> {
  await Promise.all(workspaces.filter(workspace => !workspace.parked).map(async workspace => {
    try {
      allowWorkspaceAgentResume(workspace.id);
      const agents = (await listWorkspaceAgents(workspace.id)).filter(agent => !agent.readOnly);
      if (!agents.length) return;
      await (await durableWorkspaceOwner(workspace.id, { events })).resume();
    } catch (error) { console.error(`Could not resume native Agent workspace ${workspace.id}`, error); }
  }));
}
