import { oneShotLimits } from "./one-shot-limits.ts";
import type { WorkspaceModule } from "@kintsugi/shared";
import { registerAgentToolPresentations } from "@kintsugi/agent/server";
import { registerBuiltinAgentIntegration } from "@kintsugi/builtin-agent/server";
import { codemodeIntegration } from "./integration.ts";
import { handleOneShotAgentRequest } from "./page.ts";
import { codemodeToolPresentations } from "./presentation.ts";

export const kintsugiServerModule: WorkspaceModule = {
  id: "codemode",
  initialize() {
    registerBuiltinAgentIntegration(codemodeIntegration);
    registerBuiltinAgentIntegration({ id: "one-shot-limits", extension: () => oneShotLimits });
    registerAgentToolPresentations(codemodeToolPresentations);
  },
  openApiPaths: {
    "/workspaces/{id}/agents/{agentId}/one-shot/{oneShotId}": { get: {
      summary: "A code mode script's one-shot agent's page: its live, read-only transcript",
      parameters: ["id", "agentId", "oneShotId"].map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      responses: { "200": { description: "The page, for the pane's page frame", content: { "text/html": { schema: { type: "string" } } } }, "404": { description: "No such one-shot agent" } },
    } },
  },
  staticFiles: { "/codemode.css": { url: new URL("../client/codemode.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  routes: [{ handle: (request, url) => handleOneShotAgentRequest(request, url) }],
};
