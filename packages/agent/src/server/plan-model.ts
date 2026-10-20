/*
 * Adapted from rcarmo/piclaw-addons, addons/plan-sidebar (a3444c5b).
 * Copyright (c) 2026 Rui Carmo. MIT License.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { Type, type Static } from "typebox";
import { invalidArguments } from "@kintsugi/core";

export const defaultAgentPlan = ["- [ ] Update this plan thoroughly with ongoing work", "- [ ] Clarify the current objective", "- [ ] Do the next concrete step", "- [ ] Verify the result", "- [ ] Report progress and next step"].join("\n");
export const maxPlanChars = 64 * 1024;
const text = Type.String({ maxLength: maxPlanChars });
const status = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]);
const item = Type.Object({ step: Type.String({ minLength: 1, maxLength: 4000 }), status }, { additionalProperties: false });
export type PlanItem = Static<typeof item>;
const edit = Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("delete"), Type.Literal("insert_after"), Type.Literal("insert_before"), Type.Literal("append"), Type.Literal("prepend")])), oldText: Type.Optional(text), newText: Type.Optional(text), anchorText: Type.Optional(text), text: Type.Optional(text) }, { additionalProperties: false });
const patch = Type.Object({ operation: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")]), index: Type.Optional(Type.Integer({ minimum: 1 })), match: Type.Optional(text), step: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })), status: Type.Optional(status), position: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("end")])), before: Type.Optional(text), after: Type.Optional(text) }, { additionalProperties: false });
export const agentPlanInputSchema = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("update"), Type.Literal("patch"), Type.Literal("edit"), Type.Literal("reset")])),
  markdown: Type.Optional(text), explanation: Type.Optional(text), plan: Type.Optional(Type.Array(item, { maxItems: 500 })),
  edits: Type.Optional(Type.Array(edit, { minItems: 1, maxItems: 100 })), patches: Type.Optional(Type.Array(patch, { minItems: 1, maxItems: 100 })),
  oldText: Type.Optional(text), newText: Type.Optional(text), expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
export type AgentPlanInput = Static<typeof agentPlanInputSchema>;
const checklist = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX-])\](\s*)(.*)$/;
const normalizeStep = (value: string) => value.trim().replace(/\s+/g, " ");
const fromMarker = (marker: string): PlanItem["status"] => marker.toLowerCase() === "x" ? "completed" : marker === "-" ? "in_progress" : "pending";
const toMarker = (value: PlanItem["status"]) => value === "completed" ? "x" : value === "in_progress" ? "-" : " ";
export function parseAgentPlan(markdown: string) {
  const plan: PlanItem[] = [], explanation: string[] = []; let sawTask = false;
  for (const line of markdown.split("\n")) {
    const match = line.match(checklist);
    if (match) { sawTask = true; plan.push({ step: normalizeStep(match[4]!), status: fromMarker(match[2]!) }); }
    else if (!sawTask && line.trim().startsWith(">")) explanation.push(line.trim().replace(/^>\s?/, ""));
  }
  return { plan, explanation: explanation.join("\n").trim() || null };
}
export function normalizeAgentPlan(markdown: string): string {
  if (markdown.length > maxPlanChars) throw invalidArguments("Plans may contain up to 64 KiB of text");
  let inProgress = 0;
  const normalized = markdown.replace(/\r\n?/g, "\n").split("\n").map(line => {
    const match = line.match(checklist); if (!match) return line;
    const state = fromMarker(match[2]!); if (state === "in_progress") inProgress++;
    return `${match[1]}[${toMarker(state)}]${match[3] || " "}${match[4]}`;
  }).join("\n");
  if (inProgress > 1) throw invalidArguments("A plan may have at most one in-progress item ([-])");
  if (parseAgentPlan(normalized).plan.length > 500) throw invalidArguments("A plan may have at most 500 items");
  return normalized;
}
export function structuredAgentPlan(items: PlanItem[], explanation?: string | null): string {
  const lines: string[] = [];
  if (explanation?.trim()) lines.push(...explanation.trim().split("\n").map(line => `> ${line.trim()}`.trimEnd()), "");
  for (const item of items) { const step = normalizeStep(item.step); if (!step) throw invalidArguments("Plan steps must not be empty"); lines.push(`- [${toMarker(item.status)}] ${step}`); }
  return normalizeAgentPlan(lines.join("\n").trimEnd());
}
function target(items: PlanItem[], index?: number, match?: string): number {
  if (index !== undefined) { if (index < 1 || index > items.length) throw invalidArguments("Plan item index is out of range"); return index - 1; }
  const needle = normalizeStep(match ?? ""); if (!needle) throw invalidArguments("Plan patch requires an index or match");
  const found = items.flatMap((item, i) => item.step.includes(needle) ? [i] : []);
  if (found.length !== 1) throw invalidArguments("Plan patch match must identify exactly one item");
  return found[0]!;
}
export function patchAgentPlan(markdown: string, patches: NonNullable<AgentPlanInput["patches"]>): string {
  const parsed = parseAgentPlan(markdown), items = parsed.plan.map(item => ({ ...item }));
  for (const patch of patches) {
    if (patch.operation === "add") {
      if (!patch.step?.trim()) throw invalidArguments("Adding a plan item requires step text");
      const index = patch.position === "start" ? 0 : patch.position === "end" ? items.length : patch.before ? target(items, undefined, patch.before) : patch.after ? target(items, undefined, patch.after) + 1 : items.length;
      items.splice(index, 0, { step: normalizeStep(patch.step), status: patch.status ?? "pending" });
    } else {
      const index = target(items, patch.index, patch.match);
      if (patch.operation === "remove") items.splice(index, 1);
      else items[index] = { step: patch.step === undefined ? items[index]!.step : normalizeStep(patch.step), status: patch.status ?? items[index]!.status };
    }
  }
  return structuredAgentPlan(items, parsed.explanation);
}
export function editAgentPlan(markdown: string, edits: NonNullable<AgentPlanInput["edits"]>): string {
  const ranges = edits.map((edit, order) => {
    const operation = edit.operation ?? "replace";
    const replacement = edit.text ?? edit.newText;
    if (operation === "append" || operation === "prepend") {
      if (!replacement) throw invalidArguments("Plan insert requires text");
      const at = operation === "append" ? markdown.length : 0;
      return { from: at, to: at, text: replacement, order };
    }
    const anchor = edit.anchorText ?? edit.oldText;
    if (!anchor) throw invalidArguments("Plan edit requires nonempty oldText or anchorText");
    const from = markdown.indexOf(anchor);
    if (from < 0 || markdown.indexOf(anchor, from + anchor.length) >= 0) throw invalidArguments("Plan edit text must match exactly once");
    const to = from + anchor.length;
    if (operation === "delete") return { from, to, text: "", order };
    if (operation === "replace") {
      if (edit.newText === undefined) throw invalidArguments("Plan replacement requires newText");
      return { from, to, text: edit.newText, order };
    }
    if (!replacement) throw invalidArguments("Plan insert requires text");
    const at = operation === "insert_before" ? from : to;
    return { from: at, to: at, text: replacement, order };
  }).sort((a, b) => a.from - b.from || a.order - b.order);
  let next = "", cursor = 0;
  for (const range of ranges) { if (range.from < cursor) throw invalidArguments("Plan edits must not overlap"); next += markdown.slice(cursor, range.from) + range.text; cursor = range.to; }
  return normalizeAgentPlan(next + markdown.slice(cursor));
}
export function agentPlanAction(input: AgentPlanInput): NonNullable<AgentPlanInput["action"]> { return input.action ?? (input.plan ? "update" : input.patches ? "patch" : "read"); }
export function changeAgentPlan(markdown: string, input: AgentPlanInput): string {
  switch (agentPlanAction(input)) {
    case "read": return markdown;
    case "reset": return defaultAgentPlan;
    case "write": if (input.markdown === undefined) throw invalidArguments("plan write requires markdown"); return normalizeAgentPlan(input.markdown);
    case "update": if (!input.plan) throw invalidArguments("plan update requires a plan array"); return structuredAgentPlan(input.plan, input.explanation);
    case "patch": if (!input.patches?.length) throw invalidArguments("plan patch requires patches"); return patchAgentPlan(markdown, input.patches);
    case "edit": {
      const edits = input.edits ?? (input.oldText !== undefined && input.newText !== undefined ? [{ oldText: input.oldText, newText: input.newText }] : []);
      if (!edits.length) throw invalidArguments("plan edit requires edits"); return editAgentPlan(markdown, edits);
    }
  }
}
export { agentPlanSubmission } from "../plan-submission.ts";
