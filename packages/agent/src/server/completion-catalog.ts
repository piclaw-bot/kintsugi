import type { BuiltinSlashCommand } from "./builtin-slash-commands.ts";
import { listPromptOnlyTemplates, listPromptTemplates } from "./prompt-templates.ts";
import { loadWorkspaceSkills } from "./skills.ts";
import { renderSlashCommandCatalog } from "./slash-commands.ts";

export async function renderWorkspaceCompletionCatalog(workspaceId: string, mode: "builtin" | "cli" = "builtin", additionalCommands: readonly BuiltinSlashCommand[] = []): Promise<string> {
  if (mode === "cli") {
    const templates = await listPromptOnlyTemplates(workspaceId);
    return renderSlashCommandCatalog(templates, [], "cli", additionalCommands);
  }
  const [templates, { skills }] = await Promise.all([listPromptTemplates(workspaceId), loadWorkspaceSkills(workspaceId)]);
  return renderSlashCommandCatalog(templates, skills, mode, additionalCommands);
}
