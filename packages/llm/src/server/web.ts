import { tokenTelemetry } from "./token-telemetry.ts";
import { tokenTelemetryOpenApiPaths, tokenTelemetrySettingsContribution } from "./token-telemetry-settings.ts";
import { createPiModelRuntime } from "./pi-config-models.ts";
import { modelSettingsContribution } from "./models-panel.ts";
import type { WorkspaceModule } from "@kintsugi/shared";
import { installSubscriptionCli, registerSubscriptionCli } from "./subscription-cli.ts";
export const llmWorkspaceModule: WorkspaceModule = {
  id: "llm",
  staticFiles: { "/llm.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  openApiPaths: tokenTelemetryOpenApiPaths,
  settingsContributions: [modelSettingsContribution, tokenTelemetrySettingsContribution],
  initialize(context) {
    void tokenTelemetry().start().catch(error => console.error("Could not start token telemetry:", error));
    registerSubscriptionCli(createPiModelRuntime);
    context.registerProvisioningHook({
      id: "workspace.subscription-cli",
      label: "Connect subscription CLIs",
      run: async ({ workspaceId }) => installSubscriptionCli(workspaceId, await createPiModelRuntime()),
    });
  },
};
