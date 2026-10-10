import { launchComposerCommand, recentWorkspaceTemplateStorageKey, type WorkspaceClientHooks } from "@kintsugi/shared";

export function registerLaunchComposerCommand(hooks: WorkspaceClientHooks): void {
  hooks.registerCommand({
    ...launchComposerCommand,
    scope: "global",
    run() {
      const workspaceTemplateId = localStorage.getItem(recentWorkspaceTemplateStorageKey);
      const frame = document.getElementById("launch_composer")!;
      frame.replaceChildren();
      frame.removeAttribute("src");
      frame.setAttribute("src", workspaceTemplateId ? `/launch-composer?workspaceTemplate=${encodeURIComponent(workspaceTemplateId)}` : "/launch-composer");
    },
  });
}
