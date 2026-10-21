import { handleDurableHistoryRequest } from "./durable-history.ts";
import { handleNotificationRequest } from "./notification-routes.ts";
import { handleCompletionRequest } from "./completion-routes.ts";
import { handleConfigurationRequest } from "./configuration-routes.ts";
import { handleMessageRequest } from "./message-routes.ts";
import type { AgentRouteHandler, AgentRouteOptions } from "./route-support.ts";
import { handleSessionRequest } from "./session-routes.ts";
import { handleBackgroundRequest } from "./background.ts";

const agentRouteHandlers: readonly AgentRouteHandler[] = [
  handleDurableHistoryRequest,
  handleNotificationRequest,
  handleCompletionRequest,
  handleMessageRequest,
  handleSessionRequest,
  handleConfigurationRequest,
  (request, url) => handleBackgroundRequest(request, url),
];

export async function handleAgentRequest(request: Request, url: URL, options: AgentRouteOptions = {}): Promise<Response | undefined> {
  for (const handle of agentRouteHandlers) {
    const response = await handle(request, url, options);
    if (response) return response;
  }
  return undefined;
}
