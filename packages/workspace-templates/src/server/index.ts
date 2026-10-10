import type { WorkspaceModule } from "@kintsugi/shared";
import { listWorkspaces } from "@kintsugi/workspace";
import { isGitWorkspaceTemplateInit } from "../workspace-template.ts";
import { registerWorkspaceTemplateSshAgentWorkspaceEvents, restoreWorkspaceTemplateSshAgents } from "../ssh-agent.ts";
import { registerWorkspaceTemplateWorkspaceEvents } from "../workspace-repos.ts";

const persistentSystemPromptLine = "The /persistent directory is shared by all workspaces from this template; use it for files you and the user want to keep across workspaces but not commit to git.";

export const kintsugiServerModule: WorkspaceModule = {
  id: "workspace-templates",
  async initialize(context) {
    const { events } = context;
    registerWorkspaceTemplateWorkspaceEvents(events);
    registerWorkspaceTemplateSshAgentWorkspaceEvents(events);
    await restoreWorkspaceTemplateSshAgents();
    events.on("agent_system_prompt_prepare", async ({ workspaceId, lines }) => {
      const workspace = (await listWorkspaces()).workspaces.find((entry) => entry.id === workspaceId);
      if (isGitWorkspaceTemplateInit(workspace?.init)) lines.push(persistentSystemPromptLine);
    });
  },
};
