import { providerBrandIconHtml } from "@kintsugi/shared";
import { createNativeAgentModule, nativeAgentParameters as agentParameters } from "@kintsugi/native-agent/server";
import { createCodexAgents } from "./runtime.ts";
import { codexRoutes } from "./routes.ts";
import { rendering } from "./render.ts";
import { agentTypeId, label, requireSetup, settings } from "./setup.ts";

export const kintsugiServerModule = createNativeAgentModule({
  id: "codex-agent", agentTypeId, label, iconHtml: providerBrandIconHtml("openai"),
  createAgents: createCodexAgents, rendering, routes: codexRoutes, requireSetup, settings,
  openApiPaths: {
    "/workspaces/{id}/codex-agents/{agentId}/messages": { post: { summary: "Send, steer, or run a native Codex slash command", parameters: agentParameters, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" }, requestId: { type: "string" } } } } } }, responses: { "200": { description: "Native command result or picker data" }, "202": { description: "Codex accepted the message or command" } } } },
    "/workspaces/{id}/codex-agents/{agentId}/commands": {
      post: {
        summary: "Run a native Codex slash command", parameters: agentParameters,
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["text"], properties: { text: { type: "string" }, argument: { type: "string" }, cursor: { type: "string" }, requestId: { type: "string" } },
        } } } },
        responses: { "200": { description: "Native command result or picker data" }, "202": { description: "Native command accepted" } },
      },
    },
    "/workspaces/{id}/codex-agents/{agentId}/abort": { post: { summary: "Interrupt Codex's active turn", parameters: agentParameters, responses: { "200": { description: "Interrupt requested" } } } },
    "/workspaces/{id}/codex-agents/{agentId}/model": { post: { summary: "Choose a model from Codex's catalog", parameters: agentParameters, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["model"], properties: { model: { type: "string" } } } } } }, responses: { "200": { description: "Model selected" }, "422": { description: "Unsupported model or Agent is working" } } } },
    "/workspaces/{id}/codex-agents/{agentId}/thinking-level": { post: { summary: "Choose Codex's reasoning effort", parameters: agentParameters, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["thinkingLevel"], properties: { thinkingLevel: { type: "string" } } } } } }, responses: { "200": { description: "Reasoning effort selected" }, "422": { description: "Unsupported effort or Agent is working" } } } },
  },
});
