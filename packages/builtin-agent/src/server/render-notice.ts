import { buttonHtml } from "@kintsugi/design-system/button";
import { Icons } from "@kintsugi/design-system/icons";
import { escapeHtml } from "@kintsugi/shared";
import { agentPath, type AgentRenderContext } from "@kintsugi/agent/server/render-context";

export function renderNotice(level: "info" | "error", message: string): string {
  return `<div class="agent-noticeline ${escapeHtml(level)}" data-controller="agent-notice" data-agent-notice-auto-dismiss-value="${level !== "error"}"><span role="${level === "error" ? "alert" : "status"}">${escapeHtml(message)}</span>${level === "error" ? buttonHtml({
    type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss notice" },
    attributesHtml: 'data-action="click->agent-notice#dismiss"',
  }) : ""}</div>`;
}


/** Work the crash-loop guard parked stays put until it is retried or stopped, so this notice can't be dismissed. */
export function renderParkedWorkNotice(ctx: AgentRenderContext): string {
  return `<div class="agent-noticeline error"><span role="alert">This Agent kept crashing the app at the same step, so it's paused.</span><form method="post" action="${escapeHtml(agentPath(ctx, "/retry"))}">${buttonHtml({
    type: "submit", variant: "secondary", content: { kind: "caption", caption: "Try again" },
  })}</form></div>`;
}
