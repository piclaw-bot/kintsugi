import { type KintsugiEventBus } from "@kintsugi/core";
import { workspaceRepository } from "@kintsugi/workspace/git";
import { inspectWorkspaceDeleteSafety } from "./deletion-safety.ts";
import { isGitWorkspaceTemplateInit, workspaceTemplateIdFromInit, recordWorkspaceCreation } from "./workspace-template.ts";
import { registerCommitIdentityWorkspaceEvents } from "./commit-identity.ts";
import { registerWorkspaceTemplateWorkspaceInitEvents } from "./workspace-source.ts";

export function registerWorkspaceTemplateWorkspaceEvents(events: KintsugiEventBus): void {
  registerWorkspaceTemplateWorkspaceInitEvents(events);
  registerCommitIdentityWorkspaceEvents(events);
  events.on("workspace_created", async ({ init }) => {
    if (isGitWorkspaceTemplateInit(init)) await recordWorkspaceCreation(workspaceTemplateIdFromInit(init));
  });
  events.on("workspace_delete_inspect", async ({ workspaceId, issues }) => { issues.push(...(await inspectWorkspaceDeleteSafety(path => workspaceRepository(workspaceId, path)))); });
}
