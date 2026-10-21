import { Type } from "typebox";
import { Value } from "typebox/value";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import type { AgentToolPresentation } from "@kintsugi/agent/server";
import { codeBlockHtml } from "@kintsugi/agent/server/render-markup";
import { formatDuration, type ToolView } from "@kintsugi/agent/server/transcript";
import { escapeHtml } from "@kintsugi/shared";
import { oneLine, oneShotAgentToolName } from "./one-shot-agent.ts";
import { oneShotAgentPath } from "./page.ts";

const requestSchema = Type.Object({ prompt: Type.String(), label: Type.Optional(Type.String()) });

/** The agent's answer as the script got it, as indented JSON; otherwise its text, such as why it failed. */
function resultHtml(tool: ToolView): { summary: string; html: string } | undefined {
  const text = tool.resultText?.trim();
  if (tool.status === "running" || tool.status === "streaming" || !text) return undefined;
  if (tool.status === "error") return { summary: oneLine(text, 80), html: `<pre class="agent-tool-error-output">${escapeHtml(text)}</pre>` };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { summary: oneLine(text, 80), html: `<pre class="agent-tool-result">${escapeHtml(text)}</pre>` };
  }
  return { summary: oneLine(JSON.stringify(value), 80), html: codeBlockHtml(JSON.stringify(value, null, 2), "result.json") };
}

/** A compact row opening to its body; the row's label is cut to fit, so a summary after it can be long. */
function compactDisclosure(label: string, bodyHtml: string): string {
  return disclosureHtml({ summary: { kind: "compact", width: "fill", label: { kind: "text", text: label } }, bodyHtml: `<div class="agent-tool-detail">${bodyHtml}</div>` });
}

/** Code mode's own calls carry their agent; other Agents' tools may share the name. */
function oneShotRequest(tool: ToolView) {
  return tool.childAgentId !== undefined && Value.Check(requestSchema, tool.args) ? { request: tool.args, agentId: tool.childAgentId } : undefined;
}

/** A script's `tools.agent` call: its prompt, its conversation, and the request and result behind rows. */
const oneShotAgentCall: AgentToolPresentation = {
  summary(tool) {
    const call = oneShotRequest(tool);
    if (!call) return undefined;
    return [oneLine(call.request.label ?? call.request.prompt, 80), tool.durationMs === undefined ? "" : formatDuration(tool.durationMs)].filter(Boolean).join(" · ");
  },
  detail(ctx, tool) {
    const call = oneShotRequest(tool);
    if (!call) return undefined;
    const open = ctx.readOnly ? "" : `<div class="agent-one-shot-open">${actionLinkHtml({
      href: oneShotAgentPath(ctx, call.agentId), variant: "secondary", content: { kind: "caption", caption: "Open conversation" },
      attributesHtml: 'data-action="agent-background#open"',
    })}</div>`;
    const result = resultHtml(tool);
    return `<div class="agent-one-shot-call"><p class="agent-one-shot-prompt"><span class="agent-one-shot-prompt-label">Prompt:</span> ${escapeHtml(call.request.prompt)}</p>${open}
      ${compactDisclosure("Request", codeBlockHtml(JSON.stringify(call.request, null, 2), "request.json"))}
      ${result ? compactDisclosure(`Result · ${result.summary}`, result.html) : ""}</div>`;
  },
};

export const codemodeToolPresentations = new Map([[oneShotAgentToolName, oneShotAgentCall]]);
