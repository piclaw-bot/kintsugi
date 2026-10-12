import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { Icons } from "@kintsugi/design-system/icons";
import { escapeHtml } from "@kintsugi/shared";
import { agentPath } from "@kintsugi/agent/server/render-context";
import type { ClaudeCommandResult } from "./commands.ts";
import type { ClaudeRuntime } from "./runtime.ts";
import { rendering } from "./render.ts";

export function renderCommandDialog(runtime: ClaudeRuntime, result: Exclude<ClaudeCommandResult, { kind: "done" }>): string {
  const action = agentPath(rendering.renderContext(runtime), "/commands");
  const rows = result.sessions.map(session => `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="text" value="${escapeHtml(`/resume ${session.id}`)}">${contentRowHtml({
    kind: "multiline", width: "fill", label: { kind: "text", text: session.title },
    description: `${new Date(session.updatedAt).toLocaleString()}${session.id === result.current ? " · Current conversation" : ""}`,
    element: { tag: "button", attributesHtml: `type="submit"${session.id === result.current ? " disabled" : ""}` },
  })}</form>`).join("");
  const body = `<p>Pick up an earlier conversation with this Agent. Your current one stays saved.</p>${rows || "<p>No saved conversations yet.</p>"}`;
  return dialogHtml({ element: { id: "claude_command_dialog", attributesHtml: "data-dialog-auto-show" }, titleCaption: "Resume a conversation", iconHtml: Icons.Code, bodyHtml: `<div class="form-stack">${body}</div>` });
}
