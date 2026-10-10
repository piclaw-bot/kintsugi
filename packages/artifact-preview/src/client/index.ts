import type { WorkspaceClientModule } from "@kintsugi/shared";
import { createArtifactPreviewHtmlController } from "./html-preview-controller.ts";
import { createArtifactPreviewProxyController } from "./proxy-controller.ts";

export const kintsugiClientModule: WorkspaceClientModule = {
  id: "artifact-preview",
  install({ application, Controller }) {
    application.register("artifact-preview-html", createArtifactPreviewHtmlController(Controller));
    application.register("artifact-preview-proxy", createArtifactPreviewProxyController(Controller));
  },
};
