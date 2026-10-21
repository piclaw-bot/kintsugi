import { durableWorkspaceOwner, childAgentTranscriptHtml, isOneShotAgent } from "@kintsugi/builtin-agent/server";
import { refreshingBackgroundDetail, renderBackgroundPage, type BackgroundActivity } from "@kintsugi/agent/server/background-activity";
import type { AgentRenderContext } from "@kintsugi/agent/server/render-context";
import { response } from "@kintsugi/shared/http";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";

/** Where a script's one-shot agent's conversation opens, over the pane of the Agent whose transcript links to it. */
export function oneShotAgentPath(ctx: Pick<AgentRenderContext, "workspaceId" | "agentId">, oneShotId: string): string {
  return `/workspaces/${encodeURIComponent(ctx.workspaceId)}/agents/${encodeURIComponent(ctx.agentId)}/one-shot/${encodeURIComponent(oneShotId)}`;
}

/**
 * `/workspaces/:id/agents/:agentId/one-shot/:oneShotId`: a one-shot agent's page, sliding over its root Agent's pane as
 * a background activity's does. It is no background activity: it belongs to the script that runs it, which Stop ends.
 */
export async function handleOneShotAgentRequest(request: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/one-shot\/([^/]+)$/);
  if (!match || request.method !== "GET") return undefined;
  const workspaceId = decodeURIComponent(match[1]!);
  const agentId = decodeURIComponent(match[2]!);
  const owner = await durableWorkspaceOwner(workspaceId);
  const records = await owner.catalog();
  const record = records.find(record => record.agentId === decodeURIComponent(match[3]!) && isOneShotAgent(record));
  const caller = records.find(item => item.agentId === agentId);
  if (!record || !caller || record.parentId !== caller.agentId) return new Response("One-shot agent not found", { status: 404 });
  // A subagent's transcript links to its own one-shot agents; the page slides over its root Agent's pane.
  const rootId = records.find(item => item.agentId === agentId)?.rootId ?? agentId;
  const live = await owner.harness.snapshot(LiveDoc, record.durableId, context);
  const page: BackgroundActivity = {
    key: record.agentId, kind: "one-shot agent", title: record.label, running: Boolean(live?.run), details: { Task: record.title }, stoppable: false, opens: "drill-in",
  };
  return response(renderBackgroundPage({ workspaceId, agentId: rootId }, page, refreshingBackgroundDetail(page, childAgentTranscriptHtml(workspaceId, record.agentId))));
}
