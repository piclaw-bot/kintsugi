import { renderAgentTypePicker } from "./agent-type-picker.ts";
import { buttonHtml } from "@kintsugi/design-system/button";
import { buttonGroupHtml } from "@kintsugi/design-system/button-group";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { Icons } from "@kintsugi/design-system/icons";
import { panelHtml } from "@kintsugi/design-system/panel";
import { popupHtml } from "@kintsugi/design-system/popup";
import { tabHtml, tabStripHtml } from "@kintsugi/design-system/tab-strip";
import { domId, escapeHtml, type WorkspaceAgentPane } from "@kintsugi/shared";
import type { WorkspacePresentation } from "./workspace-presentation.ts";
import { barButton, behaviorTurboStream, fullscreenViewAttributes, selectorCloseForm, type ViewCloseAction } from "./workspace-view-markup.ts";

export interface AgentPaneContribution {
  /** The selected Agent's pane, published as a child of the workspace surface. */
  pane?: WorkspaceAgentPane;
  busy?: boolean;
  requestingAttention?: boolean;
  attentionSequence?: number;
  untitled?: boolean;
  id: string;
  agentTypeId: string;
  iconHtml: string;
  title: string;
  close?: ViewCloseAction;
}

export function agentNavigationDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_navigation");
}

function agentTabListDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_tab_list");
}

export function agentBodiesDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_bodies");
}

export function agentActionsDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_actions");
}

export function agentTabDomId(workspaceId: string, agentId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_tab", agentId);
}

export function agentPaneSlotDomId(workspaceId: string, agentId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_pane", agentId);
}

export function agentContentId(workspaceId: string, agentId: string): string {
  return domId("agent_content", workspaceId, agentId);
}

function mobileAgentAttentionHtml(agents: readonly AgentPaneContribution[]): string {
  return agents.some((agent) => agent.requestingAttention) ? '<i class="status-dot attention" aria-label="Agent requesting attention"></i>' : "";
}

export function renderMobileAgentAttention(workspaceId: string, agents: readonly AgentPaneContribution[]): string {
  return `<span id="${domId("mobile_agent_attention", workspaceId)}">${mobileAgentAttentionHtml(agents)}</span>`;
}

function renderAgentTab(workspaceId: string, agent: AgentPaneContribution): string {
  return tabHtml({
    selected: false,
    label: { kind: "text", text: agent.title },
    iconHtml: agent.iconHtml,
    status: {
      busy: agent.busy, requestingAttention: agent.requestingAttention,
      attributesHtml: `data-agent-attention-id="${escapeHtml(agent.id)}"${agent.attentionSequence === undefined ? "" : ` data-attention-sequence="${agent.attentionSequence}"`}`,
    },
    containerAttributesHtml: `id="${agentTabDomId(workspaceId, agent.id)}"`,
    primary: { tag: "button", attributesHtml: `type="button" data-agent-id="${escapeHtml(agent.id)}" ${fullscreenViewAttributes(agent.id, agent.title)} data-action="click->workspace-presentation#selectAgent"` },
    closeHtml: agent.close ? selectorCloseForm(agent.close) : "",
  });
}

function agentTypeOptions(presentation: WorkspacePresentation, menu: boolean): string {
  const formId = (agentTypeId: string) => domId("create_agent", presentation.workspace.id, menu ? "menu" : "empty", agentTypeId);
  const forms = presentation.agentTypes.map(agentType => `<form id="${formId(agentType.id)}" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/agent.create.${encodeURIComponent(agentType.id)}" data-turbo="true" hidden></form>`).join("");
  return forms + renderAgentTypePicker(presentation.agentTypes, {
    attributes: agentType => `type="submit" form="${formId(agentType.id)}"${menu ? ' role="menuitem"' : ""}`,
  });
}

export function renderAgentNavigation(presentation: WorkspacePresentation): string {
  const agents = presentation.agents.length
    ? tabStripHtml({
      label: "Agents",
      id: agentTabListDomId(presentation.workspace.id),
      tabsHtml: presentation.agents.map((agent) => renderAgentTab(presentation.workspace.id, { ...agent, title: presentation.agents.length === 1 && agent.untitled ? presentation.workspace.title : agent.title })).join(""),
    })
    : `<div class="fixed-shell-workspace-title"><strong>${escapeHtml(presentation.workspace.title)}</strong></div>`;
  const menu = popupHtml({
    id: domId("agent_types", presentation.workspace.id), label: "New agent",
    trigger: { variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: "New agent" } },
    width: "content",
    contentHtml: agentTypeOptions(presentation, true),
  });
  return `${agents}${menu}`;
}

function agentEmptyId(workspaceId: string): string { return domId("agent_empty", workspaceId); }

function renderAgentEmpty(presentation: WorkspacePresentation): string {
  return `<div id="${agentEmptyId(presentation.workspace.id)}" class="agent-empty-canvas"><div class="agent-empty-choices"><div class="action-list">${agentTypeOptions(presentation, false)}</div></div></div>`;
}

function renderAgentPaneSlot(workspaceId: string, agent: AgentPaneContribution, active: boolean): string {
  return `<section id="${agentPaneSlotDomId(workspaceId, agent.id)}" class="fixed-shell-surface${active ? " is-active" : ""}" data-workspace-pane-role="agent" data-workspace-pane-id="${escapeHtml(agent.id)}" data-kintsugi-fullscreen-view-key="${escapeHtml(agent.id)}" data-workspace-logically-visible="false" tabindex="-1"><div class="fixed-shell-live-body" id="${agentContentId(workspaceId, agent.id)}" data-turbo-permanent></div></section>`;
}

function renderAgentActions(presentation: WorkspacePresentation): string {
  const parkButton = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Park, label: "Park workspace" } });
  const parkWorkspace = `<form class="fixed-shell-park-workspace" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/park" data-action="submit->workspace-navigation#parkWorkspace">${parkButton}</form>`;
  const deleteConfirmation = destructiveConfirmationHtml({
    id: domId("delete_workspace", presentation.workspace.id),
    trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Trash, label: "Delete workspace" } },
    confirmCaption: "Yes, delete",
    cancelCaption: "Oops",
  });
  const deleteWorkspace = `<form class="fixed-shell-delete-workspace" data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/delete">${deleteConfirmation}</form>`;
  const itemsHtml = `${parkWorkspace}${deleteWorkspace}${barButton("Show Work pane", "click->workspace-presentation#toggleWorkPane", Icons.Panel, "data-show-work-pane")}`;
  return buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml });
}

export function renderAgentPane(presentation: WorkspacePresentation): string {
  const panes = presentation.agents.map((agent) => renderAgentPaneSlot(presentation.workspace.id, agent, agent.id === (presentation.initialSelection?.agent ?? presentation.agents[0]?.id))).join("");
  return `<div class="fixed-shell-agent-pane"><div class="workspace-warning-stack" id="${domId("workspace_warnings", presentation.workspace.id)}">${presentation.warningsHtml ?? ""}</div>${panelHtml({
    element: { tag: "section",  attributesHtml: 'data-workspace-role-region="agent" data-workspace-presentation-target="agentPane" aria-label="Agent"' },
    headerHtml: `${barButton("Show Workspace pane", "click->workspace-navigation#toggleWorkspacePaneCollapsed", Icons.Panel, "data-show-workspace-pane")}<div id="${agentNavigationDomId(presentation.workspace.id)}" class="fixed-shell-agent-navigation">${renderAgentNavigation(presentation)}</div><div id="${agentActionsDomId(presentation.workspace.id)}" class="fixed-shell-agent-actions">${renderAgentActions(presentation)}</div>`,
    bodyHtml: `<div id="${agentBodiesDomId(presentation.workspace.id)}" class="fixed-shell-agent-bodies">${panes || renderAgentEmpty(presentation)}</div>`,
  })}</div>`;
}

export function selectAgentTurboStream(workspaceId: string, agentId: string): string {
  return behaviorTurboStream("select-agent", workspaceId, { "agent-id": agentId });
}
