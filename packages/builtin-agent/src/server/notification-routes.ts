import { requestAcceptsJson } from "@kintsugi/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { turboStream, turboStreamResponse } from "@kintsugi/shared";
import { notificationFeedbackId, notificationFrameId, renderNotificationControl, renderNotificationFeedback } from "./render-notification.ts";
import { jsonResponse, matchRoute, response } from "@kintsugi/shared/http";
import { requireAgentPresentation, type AgentRouteHandler } from "./route-support.ts";
import { currentNotificationTurn, setTurnNotification } from "./turn-notifications.ts";
import { parsePushSubscription, pushPublicKey } from "./web-push.ts";

const intentSchema = Type.Object({ turnId: Type.String(), enabled: Type.Boolean(), subscription: Type.Optional(Type.Unknown()) });

export const handleNotificationRequest: AgentRouteHandler = async (request, url, options) => {
  if (url.pathname === "/agent-notifications/public-key" && request.method === "GET") {
    return Response.json({ publicKey: await pushPublicKey() });
  }
  const params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/notification$/);
  if (!params || !["GET", "POST"].includes(request.method)) return undefined;
  const ctx = { workspaceId: params[0], agentId: params[1] };
  const runtime = await requireAgentPresentation(ctx.workspaceId, ctx.agentId, options);
  const state = () => {
    const turn = currentNotificationTurn(ctx);
    return { turnId: turn?.id ?? null, busy: runtime.isStreaming, armed: turn?.armed ?? false };
  };
  if (request.method === "GET" && requestAcceptsJson(request)) return jsonResponse(state());
  if (request.method === "GET") return response(`<turbo-frame id="${notificationFrameId(ctx)}">${renderNotificationControl(ctx, runtime.isStreaming)}</turbo-frame>`);
  const reply = (message: string, status = 200): Response => requestAcceptsJson(request)
    ? Response.json(status < 400 ? { ...state(), message } : { error: { code: status === 409 ? "turn_ended" : "invalid_arguments", message } }, { status })
    : turboStreamResponse(turboStream("replace", notificationFeedbackId(ctx.workspaceId, ctx.agentId), renderNotificationFeedback(ctx.workspaceId, ctx.agentId, message, status >= 400)), { status });
  let input;
  let subscription;
  try {
    input = await request.json();
    if (!Value.Check(intentSchema, input)) return reply("Invalid notification request.", 422);
    subscription = input.enabled ? parsePushSubscription(input.subscription) : undefined;
  } catch (error) {
    return reply(error instanceof Error ? error.message : "Invalid notification request.", 422);
  }
  if (!runtime.isStreaming || !setTurnNotification(ctx, input.turnId, subscription)) return reply("That turn has already ended. No notification was scheduled.", 409);
  return reply(input.enabled ? "Notification set for this turn." : "Notification cancelled.");
};
