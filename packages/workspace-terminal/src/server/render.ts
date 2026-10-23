import { buttonHtml } from "@kintsugi/design-system/button";
import { renderTerminalConnectionStatus, renderTerminalKeyBar } from "@kintsugi/observable-terminal/server";
import { terminalProcessSocketPath } from "@kintsugi/observable-terminal/shared";
import { domId, escapeHtml } from "@kintsugi/shared";
import { terminalViewKey } from "../shared.ts";
import type { WorkspaceTerminal } from "./workspace-terminals.ts";

export function renderTerminalView(workspaceId: string, terminal: WorkspaceTerminal): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const action = (url: string, caption: string, variant: "primary" | "secondary") => `<form method="post" action="${escapeHtml(url)}" data-turbo="true">${buttonHtml({ type: "submit", variant, content: { kind: "caption", caption } })}</form>`;
  const ended = `<div class="terminal-ended" data-terminal-view-target="ended" hidden role="status" aria-live="polite">
    <strong>This terminal has ended</strong>
    <p>${terminal.sessionRelationship === "process" ? "Its program has exited." : `The tmux session “${escapeHtml(terminal.tmuxSession)}” no longer exists.`}</p>
    <div class="terminal-ended-actions">
      ${action(`${base}/work-views/${encodeURIComponent(JSON.stringify({ type: "terminal", terminalId: terminal.id }))}/close`, "Close Terminal view", "secondary")}
    </div>
  </div>`;
  return `<section id="${domId("terminal_view", workspaceId, terminal.id)}" data-turbo-permanent class="terminal-work-view" data-work-view-source="${escapeHtml(terminalViewKey(terminal.id))}">
    <div class="terminal-view" data-controller="terminal-view" data-action="kintsugi:theme-change@document->terminal-view#theme" data-terminal-view-url-value="${escapeHtml(terminal.sessionRelationship === "process" ? terminalProcessSocketPath(workspaceId, terminal.id) : `${base}/views/${encodeURIComponent(terminalViewKey(terminal.id))}/ws`)}" data-terminal-id="${escapeHtml(terminal.id)}">
      ${ended}
      <div class="terminal-stage" data-terminal-view-target="stage">
      ${renderTerminalConnectionStatus("terminal-view")}
      <div class="observable-terminal-host" data-terminal-view-target="host" tabindex="0" data-action="pointerdown->terminal-view#dragPointer:capture
        pointermove->terminal-view#dragPointer:capture
        pointerup->terminal-view#dragPointer:capture
        pointercancel->terminal-view#dragPointer:capture
        lostpointercapture->terminal-view#dragPointer:capture
        keydown->terminal-view#allowNativePaste:capture
        touchstart->terminal-view#startTerminalTouch:passive
        touchmove->terminal-view#moveTerminalTouch:passive
        touchcancel->terminal-view#cancelTerminalTouch
        touchend->terminal-view#finishTerminalTouch:!passive">
        <div class="terminal-loading" role="status" aria-label="Loading terminal"><span class="activity-spinner" aria-hidden="true"></span></div>
      </div>
      </div>
      ${renderTerminalKeyBar("terminal-view")}
    </div>
  </section>`;
}
