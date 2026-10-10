import { registerMarkdownEmbed } from "@kintsugi/markdown";
import type { WorkspaceModule } from "@kintsugi/shared";
import { handleInlineContentRequest } from "./inline-content-routes.ts";
import { renderInlineContentReference } from "./render-reference.ts";

export const kintsugiServerModule: WorkspaceModule = {
  id: "inline-content",
  staticFiles: {
    "/inline-content.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  routes: [{ handle: handleInlineContentRequest }],
  initialize() {
    registerMarkdownEmbed("inline-content", renderInlineContentReference);
  },
};
