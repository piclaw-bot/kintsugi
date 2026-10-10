import { KintsugiCoreError, readJsonObject, requestAcceptsJson } from "@kintsugi/core";
import { turboStreamResponse } from "@kintsugi/shared";
import { parseModelRef, setAgentModelThinkingLevel } from "@kintsugi/llm/server";
import { matchRoute } from "@kintsugi/shared/http";
import { invalidateAgentView, requireAgentController, type AgentRouteHandler } from "./route-support.ts";

export const handleConfigurationRequest: AgentRouteHandler = async (request, url, options) => {
  let params: string[] | undefined;
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/model$/)) && request.method === "POST") {
    const json = requestAcceptsJson(request);
    const value = json ? (await readJsonObject(request)).model : (await request.formData()).get("model");
    const model = parseModelRef(String(value ?? ""));
    if (!model) {
      if (json) throw new KintsugiCoreError("invalid_arguments", "valid model is required");
      return turboStreamResponse("");
    }
    const runtime = await requireAgentController(params[0], params[1], options);
    await runtime.configure({ model: { provider: model.provider, modelId: model.id } });
    await invalidateAgentView(options, params[0], params[1]);
    return json ? Response.json({ agent: { agentId: params[1], model: `${model.provider}::${model.id}` } }) : turboStreamResponse("");
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/thinking-level$/)) && request.method === "POST") {
    const json = requestAcceptsJson(request);
    const value = json ? (await readJsonObject(request)).thinkingLevel : (await request.formData()).get("thinkingLevel");
    const thinkingLevel = String(value ?? "");
    if (!thinkingLevel) {
      if (json) throw new KintsugiCoreError("invalid_arguments", "thinkingLevel is required");
      return turboStreamResponse("");
    }
    const runtime = await requireAgentController(params[0], params[1], options);
    await runtime.configure({ thinkingLevel });
    const model = (await runtime.settings()).model;
    if (model) await setAgentModelThinkingLevel("builtin", { provider: model.provider, id: model.modelId }, thinkingLevel);
    await invalidateAgentView(options, params[0], params[1]);
    return json ? Response.json({ agent: { agentId: params[1], thinkingLevel } }) : turboStreamResponse("");
  }
  return undefined;
};
