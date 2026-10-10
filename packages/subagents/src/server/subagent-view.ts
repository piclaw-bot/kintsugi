import { disclosureHtml, type DisclosureSummary } from "@kintsugi/design-system/disclosure";
import { listWorkspaceAgents, durableWorkspaceOwner, WorkspaceAgents, type AgentLivePresentationSubscription, type AgentRouteHandler } from "@kintsugi/builtin-agent/server";
import { ids } from "@kintsugi/agent/server/render-context";
import { requestAcceptsJson } from "@kintsugi/core";
import { createLivePresentation, escapeHtml as h } from "@kintsugi/shared";
import { response } from "@kintsugi/shared/http";
import { nativeSnapshot, viewPath, type NativeSubagentView as SubagentRecord } from "./native-view-state.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Delegation } from "./native-state.ts";

export async function renderSubagentsControl(workspaceId: string, agentId: string): Promise<string> {
  const agents = (await nativeSnapshot(workspaceId)).agents.filter(agent => agent.rootId === agentId);
  return `<div class="subagents-control" data-controller="subagents"
    data-subagents-workspace-id-value="${h(workspaceId)}" data-subagents-agent-id-value="${h(agentId)}"
    data-action="kintsugi:workspace-agent-selected@document->subagents#sync kintsugi:workspace-pane-visible@document->subagents#sync kintsugi:workspace-pane-hidden@document->subagents#sync visibilitychange@document->subagents#sync agent:turn-reveal->subagents#loaded:stop toggle->subagents#toggle:capture">${disclosureHtml({
    element: { attributesHtml: `data-subagents-target="panel"${agents.length ? "" : " hidden"}` },
    summary: { kind: "compact", width: "fill", label: { kind: "text", text: "Subagents" },
      trailingHtml: `<span id="subagents-status-${h(agentId)}">${statusHtml(agents)}</span>` },
    bodyHtml: `<div id="${h(contentId(workspaceId, agentId))}" data-turbo-permanent></div>`,
  })}</div>`;
}
function isActive(agent: SubagentRecord): boolean {
  return agent.status === "running" || agent.status === "pending";
}
function statusHtml(agents: SubagentRecord[]): string {
  const count = agents.filter(isActive).length;
  return `<span data-subagents-target="status" data-subagent-count="${agents.length}">${count} active</span>`;
}

export const handleSubagentRequest: AgentRouteHandler = async (request, url) => {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/subagents$/);
  if (!match || request.method !== "GET") return undefined;
  const workspaceId = decodeURIComponent(match[1]!);
  const roots = await listWorkspaceAgents(workspaceId);
  const parentId = url.searchParams.get("agent") ?? roots[0]?.agentId;
  const parent = roots.find((agent) => agent.agentId === parentId);
  if (!parent) return new Response("Agent not found", { status: 404 });
  const snapshot = await nativeSnapshot(workspaceId);
  const agents = snapshot.agents.filter(agent => agent.rootId === parent.agentId);
  if (requestAcceptsJson(request)) return Response.json({ parent: { id: parentId, title: parent.title }, agents, messages: snapshot.messages.filter((message) => message.to === parentId || message.from === parentId || agents.some((agent) => agent.id === message.to || agent.id === message.from)) });
  const open = new Set(url.searchParams.getAll("open"));
  let revealed = agents.find((agent) => agent.id === url.searchParams.get("reveal"));
  while (revealed) { open.add(revealed.id); revealed = agents.find((agent) => agent.id === revealed!.parentId); }
  return response(`<turbo-frame id="${h(contentId(workspaceId, parent.agentId))}" data-turbo-permanent refresh="morph">${childrenHtml(workspaceId, parent.agentId, agents, open)}</turbo-frame>`);
};

function contentId(workspaceId: string, rootId: string): string { return `subagents-content-${workspaceId}-${rootId}`; }
function childrenId(workspaceId: string, parentId: string): string { return `subagent-children-${workspaceId}-${parentId}`; }
function branchSummary(agent: SubagentRecord, agents: SubagentRecord[]): DisclosureSummary {
  const tone = isActive(agent) ? "running" : agent.status === "failed" ? "danger" : agent.status === "completed" ? "success" : "";
  return { kind: "compact", width: "fill", attributesHtml: `id="subagent-summary-${h(agent.id)}"`, label: { kind: "text", text: viewPath(agents, agent.id) }, trailingHtml: `<span class="subagent-state"><span class="status-dot ${tone}"></span>${h(agent.status)}</span>` };
}
function branchHtml(workspaceId: string, agent: SubagentRecord, agents: SubagentRecord[], open: Set<string>): string {
  return `<div class="subagent-branch">${disclosureHtml({
    element: { id: `subagent-${agent.id}`, attributesHtml: `data-subagent-id="${h(agent.id)}" data-subagents-target="branch"` },
    summary: branchSummary(agent, agents), open: open.has(agent.id),
    bodyHtml: `<div id="${ids.transcript({ workspaceId, agentId: agent.id })}" class="agent-transcript" data-turbo-permanent></div>${childrenHtml(workspaceId, agent.id, agents, open)}`,
  })}</div>`;
}
function childrenHtml(workspaceId: string, parentId: string, agents: SubagentRecord[], open = new Set<string>()): string {
  return `<div id="${h(childrenId(workspaceId, parentId))}" class="action-list">${agents.filter((agent) => agent.parentId === parentId).map((agent) => branchHtml(workspaceId, agent, agents, open)).join("")}</div>`;
}

/** Publish the tree while preserving independently subscribed child transcripts. */
export async function subscribeSubagentTree(workspaceId: string, rootId: string, listener: (html: string) => void): Promise<AgentLivePresentationSubscription> {
  const roots = await listWorkspaceAgents(workspaceId);
  if (!roots.some((root) => root.agentId === rootId)) throw new Error(`Agent not found: ${rootId}`);
  const owner = await durableWorkspaceOwner(workspaceId);
  let snapshot = await nativeSnapshot(workspaceId);
  const presentation = createLivePresentation(() => {
    const agents = snapshot.agents.filter(agent => agent.rootId === rootId);
    return [{
      target: contentId(workspaceId, rootId),
      html: childrenHtml(workspaceId, rootId, agents),
    }, {
      target: `subagents-status-${rootId}`,
      html: statusHtml(agents),
      morph: false,
    }];
  });
  const watches = await Promise.all([
    owner.harness.watchDoc(WorkspaceAgents, BACKGROUND_CONTEXT),
    owner.harness.watchDoc(Delegation, BACKGROUND_CONTEXT),
    owner.harness.watchTaskGraph(BACKGROUND_CONTEXT),
  ]);
  let updates = Promise.resolve();
  const refresh = () => updates = updates.then(async () => { snapshot = await nativeSnapshot(workspaceId); presentation.invalidate(); });
  for (const watch of watches) watch?.start(refresh);
  await refresh();

  const subscription = presentation.subscribe(listener);
  return { unsubscribe() { for (const watch of watches) void watch?.stop(); subscription.unsubscribe(); presentation.dispose(); } };
}
