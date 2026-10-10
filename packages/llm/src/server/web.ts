import { createPiModelRuntime } from "./pi-config-models.ts";
import { modelSettingsContribution } from "./models-panel.ts";
import type { WorkspaceModule } from "@kintsugi/shared";
import { installSubscriptionCli, registerSubscriptionCli } from "./subscription-cli.ts";
export const llmWorkspaceModule: WorkspaceModule = {
  id: "llm",
  staticFiles: { "/llm.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  settingsContributions: [modelSettingsContribution],
  initialize(context) {
    registerSubscriptionCli(createPiModelRuntime);
    context.registerProvisioningHook({
      id: "workspace.subscription-cli",
      label: "Connect subscription CLIs",
      run: async ({ workspaceId }) => installSubscriptionCli(workspaceId, await createPiModelRuntime()),
    });
  },
};
