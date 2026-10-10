import { registerMarkdownEmbed } from "@kintsugi/markdown";
import type { WorkspaceModule } from "@kintsugi/shared";
import { renderArtifactPreview } from "./render-reference.ts";

export const kintsugiServerModule: WorkspaceModule = {
  id: "artifact-preview",
  staticFiles: {
    "/artifact-preview.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  initialize() {
    registerMarkdownEmbed("artifact-preview", ({ workspaceId, target }) => renderArtifactPreview(workspaceId, target));
  },
};
