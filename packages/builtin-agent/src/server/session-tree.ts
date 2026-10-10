import { KintsugiCoreError } from "@kintsugi/core";
import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { escapeHtml } from "@kintsugi/shared";
import { response, textResponse } from "@kintsugi/shared/http";

export const treeFilterOptions = [
  ["default", "Default"],
  ["no-tools", "No tools"],
  ["user-only", "User only"],
  ["labeled-only", "Labeled"],
  ["all", "All entries"],
] as const;

export type TreeFilterMode = typeof treeFilterOptions[number][0];

function parseTreeFilterMode(value: string | null): TreeFilterMode {
  return treeFilterOptions.find(([mode]) => mode === value)?.[0] ?? "default";
}

function renderAgentTreeContinuationMenu(entryId: string): string {
  const continueOption = contentRowHtml({
    width: "fill",
    kind: "multiline",
    label: { kind: "text", text: "Continue on a new branch" },
    description: "Keep earlier branches in history.",
    element: {
      tag: "button",
      attributesHtml: 'type="button" role="option" aria-selected="true" data-completion-kind="tree-continue"',
    },
  });
  return `<div class="agent-completion-menu agent-tree-summary-menu" role="listbox" aria-label="Continue from this point" data-tree-entry="${escapeHtml(entryId)}">
    <header class="agent-tree-header"><span class="agent-tree-heading"><b>Continue from this point</b></span></header>
    <div class="agent-tree-summary-choices action-list">${continueOption}</div>
  </div>`;
}

export async function handleAgentTreeRequest(request: Request, url: URL, suffix: string,
  presentation: () => Promise<import("./agent-presentation.ts").AgentPresentation>,
  controller: () => ReturnType<typeof import("./runtime.ts").getWorkspaceAgentController>,
): Promise<Response | undefined> {
  if (suffix === "/summary" && request.method === "GET") {
    const entry = url.searchParams.get("entry") ?? "";
    if (!entry) throw new KintsugiCoreError("invalid_arguments", "tree entry is required");
    return response(renderAgentTreeContinuationMenu(entry));
  }
  if (suffix === "/label" && request.method === "POST") {
    const form = await request.formData();
    const entry = String(form.get("entry") ?? "");
    const label = String(form.get("label") ?? "");
    const operation = form.get("operation");
    if (!entry || !label.trim() || (operation !== "add" && operation !== "remove")) throw new KintsugiCoreError("invalid_arguments", "tree entry, label, and valid operation are required");
    await (await controller()).label(entry, label, operation);
    return new Response(null, { status: 204 });
  }
  if (suffix === "" && request.method === "GET") {
    const html = await (await presentation()).treeHtml({ filter: parseTreeFilterMode(url.searchParams.get("filter")), query: url.searchParams.get("q") ?? "" });
    return response(html);
  }
  if (suffix === "" && request.method === "POST") {
    const form = await request.formData();
    const entry = String(form.get("entry") ?? "");
    if (!entry) throw new KintsugiCoreError("invalid_arguments", "tree entry is required");
    const summaryMode = String(form.get("summaryMode") ?? "none");
    if (summaryMode !== "none" && summaryMode !== "summary" && summaryMode !== "custom") throw new KintsugiCoreError("invalid_arguments", "valid summary mode is required");
    if (summaryMode !== "none") throw new KintsugiCoreError("invalid_arguments", "Continue without a summary for this history.");
    await (await controller()).navigate(entry);
    return textResponse("");
  }
  return undefined;
}
