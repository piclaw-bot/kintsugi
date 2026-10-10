import { listFileCompletions, renderFileCompletionMenu } from "@kintsugi/agent/server/file-completions";
import { expandSlashCommand } from "@kintsugi/agent/server/slash-command-input";
import { matchRoute, response, textResponse } from "@kintsugi/shared/http";
import { type AgentRouteHandler } from "./route-support.ts";
import { resolveAgent } from "./delegation.ts";

export const handleCompletionRequest: AgentRouteHandler = async (request, url) => {
  let params: string[] | undefined;
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/completions$/)) && request.method === "GET") {
    await resolveAgent(params[0], params[1]);
    const query = url.searchParams.get("q") ?? "";
    const mode = url.searchParams.get("mode") === "fuzzy" ? "fuzzy" : "direct";
    return response(renderFileCompletionMenu(await listFileCompletions(params[0], query, mode)));
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/completions\/slash-command-expand$/)) && request.method === "POST") {
    await resolveAgent(params[0], params[1]);
    const form = await request.formData();
    const expanded = await expandSlashCommand(params[0], String(form.get("text") ?? ""));
    return textResponse(expanded);
  }
  return undefined;
};
