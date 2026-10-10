import type { KintsugiEventBus } from "@kintsugi/core";
import type { WorkspaceModule } from "@kintsugi/shared";
import { providerBrandIconHtml } from "@kintsugi/shared";
import { createCodexAgents } from "./runtime.ts";
import { codexRoutes } from "./routes.ts";
import { channelName, paneHtml } from "./render.ts";
import { agentTypeId, label, requireSetup, settings } from "./setup.ts";

const agentParameters = ["id", "agentId"].map(name => ({ name, in: "path", required: true, schema: { type: "string" } }));
let events: KintsugiEventBus;
const agents = createCodexAgents(() => events);
export const kintsugiServerModule: WorkspaceModule = {
  id: "codex-agent",
  initialize(context) {
    events = context.events;
    context.events.on("kintsugi_host_stopping", () => agents.disposeAll());
    context.events.on("workspace_deleting", ({ workspaceId }) => agents.disposeWorkspace(workspaceId));
    context.events.on("workspace_agent_turn_finished", ({ workspaceId, agentId }) => {
      if (agents.list(workspaceId).some(record => record.id === agentId)) context.registry.requestAttention(workspaceId);
    });
    context.onWorkspaceRemoved(workspaceId => agents.disposeWorkspace(workspaceId));
  },
  cableChannels: [{
    name: channelName,
    async subscribe(identifier, listener) {
      if (identifier.channel !== "module" || identifier.name !== channelName || !identifier.params.agentId) throw new Error("Invalid Codex channel");
      return (await agents.ready(identifier.workspaceId, identifier.params.agentId)).presentation.subscribe(listener);
    },
  }],
  routes: [{ handle: codexRoutes(agents) }],
  agentType: {
    id: agentTypeId, label, iconHtml: providerBrandIconHtml("openai"),
    async create({ workspaceId }) { await requireSetup(); return agents.create(workspaceId); },
    tabs: {
      async list({ workspaceId }) { return agents.list(workspaceId).map(record => ({ id: record.id, title: record.title })); },
      async render({ workspaceId, agentId }) { return paneHtml(await agents.ready(workspaceId, agentId)); },
      close: ({ workspaceId, agentId }) => agents.close(workspaceId, agentId),
    },
    launch: {
      renderFooter: settings.renderFooter,
      async prepare(parameters) { await requireSetup(); return { agent: await settings.prepare(parameters) }; },
      async submit(form) {
        await requireSetup();
        const selected = await settings.prepare({ model: String(form.get("model") ?? ""), thinkingLevel: String(form.get("thinkingLevel") ?? "") });
        return { async prepare() { return { agent: selected }; } };
      },
      async prepareWorkspace(workspaceId, context) {
        await requireSetup();
        if (!agents.list(workspaceId).length) await agents.create(workspaceId, context?.agent);
      },
    },
  },
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
};
