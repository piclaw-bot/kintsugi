import { Icons } from "@kintsugi/design-system/icons";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { panelHtml } from "@kintsugi/design-system/panel";
import { copyButtonHtml } from "@kintsugi/design-system/copy-button";
import { buttonGroupHtml } from "@kintsugi/design-system/button-group";
import { buttonHtml } from "@kintsugi/design-system/button";
import { observableTerminalStaticFiles, terminalOutputHtml } from "@kintsugi/observable-terminal/server";
import { domId, escapeHtml } from "@kintsugi/shared";
import type { WorkspaceProvisionStep, WorkspaceProvisionSnapshot, WorkspaceProvisionStepStatus } from "../provisioning.ts";

export const workspaceProvisioningStaticFiles = {
  "/provisioning.css": { url: new URL("../client/provisioning.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...observableTerminalStaticFiles,
} as const;

function stepStatusAttributes(status: WorkspaceProvisionStepStatus): string {
  if (status === "done") return ' role="checkbox" aria-checked="true"';
  if (status === "running") return ' aria-busy="true"';
  return ` data-status="${status}"`;
}

function renderStatusMarker(status: WorkspaceProvisionStepStatus): string {
  const statusAttributes = status === "failed" || status === "warning" ? ` role="img" aria-label="${status === "warning" ? "Warning" : "Failed"}"` : "";
  const marker = status === "done" ? Icons.Check : status === "failed" ? Icons.Close : status === "warning" ? Icons.Exclamation : "";
  return `<span class="status-list__marker"${statusAttributes}>${marker}</span>`;
}

interface ProvisionFailureActions {
  stepId: string;
  description?: string;
  actionsHtml: string;
}

function renderProvisionStep(workspaceId: string, step: WorkspaceProvisionStep, waiting: WorkspaceProvisionSnapshot["waiting"], failureActions?: ProvisionFailureActions): string {
  const awaitingContinue = waiting?.stepId === step.id;
  const liveOutput = step.status === "running" ? step.output : undefined;
  const activity = liveOutput
    ? `<pre class="provision-terminal-progress provision-output-log" data-controller="auto-scroll">${terminalOutputHtml(liveOutput)}</pre>`
    : step.status === "running" && step.terminalSocketPath
      ? `<div id="${domId("provision_terminal", workspaceId, step.id, step.terminalSocketPath)}" data-turbo-permanent class="provision-terminal observable-terminal-host" data-controller="provision-terminal" data-action="kintsugi:theme-change@document->provision-terminal#theme" data-provision-terminal-url-value="${escapeHtml(step.terminalSocketPath)}"></div>`
      : "";
  const log = [
    step.output ? terminalOutputHtml(step.output) : undefined,
    step.error && !step.output?.includes(step.error) ? escapeHtml(step.error) : undefined,
  ].filter(Boolean).join("\n\n");
  const output = log && step.status !== "running" ? disclosureHtml({ open: Boolean(step.error), summary: { kind: "compact", label: { kind: "text", text: "View output" } }, bodyHtml: `<pre class="provision-output-log provision-output" data-controller="auto-scroll">${log}</pre>` }) : "";
  const detailText = step.status === "warning" ? "Continued despite this failure" : step.detail;
  const detail = detailText ? `<span class="r-sub provision-step-detail">${escapeHtml(detailText)}</span>` : "";
  const continueUrl = `/workspaces/${encodeURIComponent(workspaceId)}/provisioning/continue`;
  const description = failureActions?.description ? `<p class="provision-failure-description">${escapeHtml(failureActions.description)}</p>` : "";
  const actions = awaitingContinue
    ? `<form class="provision-actions" method="post" action="${continueUrl}">${buttonGroupHtml({
      orientation: "horizontal",
      semantics: "group",
      label: "Failed step options",
      itemsHtml: (waiting.retryable ? buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Retry" }, attributesHtml: `formaction="${continueUrl}?action=retry"` }) : "")
        + (waiting.continuable ? buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Continue anyway" } }) : "")
        + (failureActions?.actionsHtml ?? ""),
    })}</form>`
    : failureActions ? `<div class="provision-actions">${failureActions.actionsHtml}</div>` : "";
  return `<li class="status-list__item provision-step"${stepStatusAttributes(step.status)}>${renderStatusMarker(step.status)}<div class="provision-step-content"><span class="provision-step-label">${escapeHtml(step.label)}</span>${detail}${activity}${output}${description}${actions}</div></li>`;
}

export function renderWorkspaceLaunchPrompt(launchPrompt: string | undefined, settingsHtml?: string): string {
  const prompt = launchPrompt?.trim();
  if (!prompt) return "";
  return `<div class="provision-launch-prompt">${panelHtml({
    element: { tag: "section", attributesHtml: 'aria-label="Launch prompt"' },
    headerHtml: `<h2 class="panel__title">Launch prompt</h2>${copyButtonHtml({ label: "Copy launch prompt", copyText: prompt })}`,
    bodyHtml: `<p>${escapeHtml(prompt)}</p>`,
    footerHtml: settingsHtml ? `<div class="provision-launch-settings">${settingsHtml}</div>` : undefined,
    bodyLayout: "padded",
    bodyOverflow: "scroll",
  })}</div>`;
}

export function renderWorkspaceProvisioning(workspaceId: string, snapshot: WorkspaceProvisionSnapshot | undefined, options: { failed?: boolean; error?: string; failureActions?: ProvisionFailureActions } = {}): string {
  const body = snapshot?.steps.map((step) => renderProvisionStep(workspaceId, step, snapshot.waiting, options.failureActions?.stepId === step.id ? options.failureActions : undefined)).join("") ?? "";
  const failure = snapshot?.error ?? (options.failed ? options.error : undefined);
  const error = snapshot?.steps.some((step) => step.error === failure) ? undefined : failure;
  const progress = body || (options.failed ? "" : '<li class="status-list__item provision-step" aria-busy="true"><span class="status-list__marker"></span><div class="provision-step-content"><span class="provision-step-label">Preparing workspace</span></div></li>');
  return `<section aria-label="Workspace preparation">${error ? `<pre class="provision-output-log">${escapeHtml(error)}</pre>` : ""}${progress ? `<ol class="status-list status-list--compact provision-list">${progress}</ol>` : ""}</section>`;
}
