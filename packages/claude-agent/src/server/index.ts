import { providerBrandIconHtml } from "@kintsugi/shared";
import { createNativeAgentModule, nativeAgentParameters as agentParameters } from "@kintsugi/native-agent/server";
import { createClaudeAgents } from "./runtime.ts";
import { claudeRoutes } from "./routes.ts";
import { rendering } from "./render.ts";
import { agentTypeId, label, requireSetup, settings } from "./setup.ts";

export const kintsugiServerModule = createNativeAgentModule({
  id: "claude-agent", agentTypeId, label, iconHtml: providerBrandIconHtml("anthropic"),
  createAgents: createClaudeAgents, rendering, routes: claudeRoutes, requireSetup, settings,
  openApiPaths: {
    "/workspaces/{id}/claude-code-agents/{agentId}/messages": { post: { summary: "Send or steer a prompt, or run a Claude Code slash command", parameters: agentParameters, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" }, requestId: { type: "string" } } } } } }, responses: { "200": { description: "Command picker data" }, "202": { description: "Claude Code accepted the message or command" } } } },
    "/workspaces/{id}/claude-code-agents/{agentId}/commands": {
      post: {
        summary: "Run /new, /fork or /resume for a Claude Code Agent", parameters: agentParameters,
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" }, argument: { type: "string" } } } } } },
        responses: { "200": { description: "Saved conversations to resume" }, "202": { description: "Command accepted" } },
      },
    },
    "/workspaces/{id}/claude-code-agents/{agentId}/abort": { post: { summary: "Interrupt Claude Code's active turn", parameters: agentParameters, responses: { "200": { description: "Interrupt requested" } } } },
    "/workspaces/{id}/claude-code-agents/{agentId}/model": { post: { summary: "Choose a model from Claude Code's catalog", parameters: agentParameters, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["model"], properties: { model: { type: "string" } } } } } }, responses: { "200": { description: "Model selected" }, "422": { description: "Unsupported model or Agent is working" } } } },
    "/workspaces/{id}/claude-code-agents/{agentId}/thinking-level": { post: { summary: "Choose Claude Code's effort level", parameters: agentParameters, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["thinkingLevel"], properties: { thinkingLevel: { type: "string" } } } } } }, responses: { "200": { description: "Effort level selected" }, "422": { description: "Unsupported effort or Agent is working" } } } },
  },
});
