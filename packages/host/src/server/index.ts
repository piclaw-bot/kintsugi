import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { hostDiagnosticGroups } from "../diagnostics.ts";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { buttonHtml } from "@kintsugi/design-system/button";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { Icons } from "@kintsugi/design-system/icons";
import { requestAcceptsJson } from "@kintsugi/core";
import { hostOpenApiPaths } from "./openapi.ts";
import { tabHtml, tabStripHtml } from "@kintsugi/design-system/tab-strip";
import { observableTerminalStaticFiles, renderTerminalConnectionStatus } from "@kintsugi/observable-terminal/server";
import { escapeHtml, type WorkspaceModule } from "@kintsugi/shared";
import { response } from "@kintsugi/shared/http";
import { hostAvailable, hostRequest, hostTerminalSocket } from "./connection.ts";
import type { HostSample, HostTerminal } from "../protocol.ts";

const terminalFrame = "host_terminals";
const statsFrame = "host_stats";
const e = escapeHtml;
function failure(error: string): string {
  return `<div class="host-error" role="alert" data-controller="host-dismiss"><p>${e(error)}</p>${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss host error" }, attributesHtml: 'data-action="host-dismiss#dismiss"' })}</div>`;
}
function sampleForm() {
  return `<form method="post" action="/host/sample" data-turbo-frame="${statsFrame}">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Sample" }, attributesHtml: 'data-turbo-submits-with="Sampling…"' })}</form>`;
}

function renderDiagnosticTable(sample: HostSample): string {
  const metrics = new Map(sample.metrics.map(metric => [metric.id, metric]));
  const groups = hostDiagnosticGroups.map(group => `<tbody>${group.rows.map((row, index) => {
    const metric = metrics.get(row.id);
    const attention = !metric || metric.warning;
    return `<tr>${index === 0 ? `<th class="host-resource" scope="rowgroup" rowspan="${group.rows.length}">${group.name}</th>` : ""}<th scope="row"><span>${row.label}</span> <span class="host-metric-context">${row.context}</span></th><td${attention ? ' class="host-reading-warning"' : ""}>${attention ? '<span class="status-dot warning" role="img" aria-label="Needs attention"></span>' : ""}<span>${metric ? e(metric.value) : "Unavailable"}</span></td></tr>`;
  }).join("")}</tbody>`).join("");
  return `<div class="host-table-wrap"><table class="host-diagnostics-table" aria-label="Host resource measurements"><thead><tr><th scope="col">Resource</th><th scope="col">Measurement</th><th scope="col">Reading</th></tr></thead>${groups}</table></div>`;
}

function renderSample(sample?: HostSample, error?: string): string {
  const unavailable = sample?.sections.filter(section => section.error).length ?? 0;
  const timestamp = sample ? `<time datetime="${e(sample.sampledAt)}" title="${e(new Date(sample.sampledAt).toLocaleString())}">${e(new Date(sample.sampledAt).toLocaleTimeString())}</time> · ${(sample.durationMs / 1000).toFixed(1)}s collection` : "Read-only snapshot · no background polling";
  const details = sample ? disclosureHtml({
    summary: { kind: "compact", label: { kind: "text", text: "Detailed diagnostics" }, trailingHtml: `<span>${sample.sections.length} probes${unavailable ? ` · <span class="host-reading-warning">${unavailable} unavailable</span>` : ""}</span>` },
    bodyHtml: `<div class="host-probes">${sample.sections.map(section => `<div class="host-probe">${disclosureHtml({
      summary: { kind: "multiline", label: { kind: "text", text: section.title }, trailingHtml: `<span class="${section.error ? "host-reading-warning" : "host-probe-state"}">${section.error ? '<span class="status-dot warning" aria-hidden="true"></span> Unavailable' : "Collected"}</span>` },
      bodyHtml: `<pre>${e(section.text)}</pre>`,
    })}</div>`).join("")}</div>`,
  }) : "";
  return `<turbo-frame id="${statsFrame}"><section class="host-stats"><header class="host-section-heading"><div><h3>Diagnostics</h3><p>${sample ? "Sampled " : ""}${timestamp}</p></div>${sampleForm()}</header>${error ? failure(error) : ""}${sample ? renderDiagnosticTable(sample) : ""}${details}</section></turbo-frame>`;
}

function closeTerminalForm(terminal: HostTerminal): string {
  return `<form method="post" action="/host/terminals/${terminal.id}/terminate" data-turbo-frame="${terminalFrame}">${destructiveConfirmationHtml({
    id: `close_host_terminal_${terminal.id}`,
    trigger: { type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: `Close ${terminal.title} and stop its processes` } },
    confirmCaption: "Stop processes & close",
    cancelCaption: "Keep running",
  })}</form>`;
}
function renderTerminals(terminals: HostTerminal[], selected?: string): string {
  const active = terminals.find(t => t.id === selected) ?? terminals[0];
  const tabs = terminals.map(t => tabHtml({
    label: { kind: "text", text: t.title }, iconHtml: Icons.Terminal, selected: t.id === active?.id,
    primary: { tag: "a", attributesHtml: `id="host_tab_${t.id}" href="/host/terminals?selected=${t.id}" data-turbo-frame="${terminalFrame}" aria-controls="host_terminal_panel"` },
    closeHtml: closeTerminalForm(t),
  })).join("");
  return `<turbo-frame id="${terminalFrame}"><section class="host-terminals"><header class="host-terminal-heading">${terminals.length ? tabStripHtml({ id: "host_terminal_tabs", label: "Host terminals", tabsHtml: tabs }) : ""}<form method="post" action="/host/terminals" data-turbo-frame="${terminalFrame}">${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "+ New host terminal" } })}</form></header>
  ${active ? `<section id="host_terminal_panel" role="tabpanel" aria-labelledby="host_tab_${active.id}" data-controller="host-terminal" data-host-terminal-url-value="/host/terminals/${active.id}/ws">${renderTerminalConnectionStatus("host-terminal")}<div class="host-terminal-screen observable-terminal-host" data-host-terminal-target="host"></div></section>` : `<p class="host-empty">Host terminals run as root in Kintsugi System, outside your Workspaces. Commands can affect the app and every Workspace, and can access secrets.</p>`}</section></turbo-frame>`;
}
async function handle(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname !== "/host" && !url.pathname.startsWith("/host/")) return;
  const json = requestAcceptsJson(request);
  if (url.pathname === "/host" && request.method === "GET") {
    if (json) return Response.json({ available: hostAvailable(), url: "/host", boundary: "Kintsugi System", shellUser: "root" });
    return Response.redirect(new URL("/settings?section=host", url), 303);
  }
  if (!hostAvailable()) return json
    ? Response.json({ error: { code: "host_unavailable", message: "Host access requires Kintsugi System" } }, { status: 503 })
    : response("Host access requires Kintsugi System", { status: 503 });
  const sampling = url.pathname === "/host/sample" && ["GET", "POST"].includes(request.method);
  const listing = url.pathname === "/host/terminals" && request.method === "GET";
  const creating = url.pathname === "/host/terminals" && request.method === "POST";
  const closing = request.method === "POST" ? url.pathname.match(/^\/host\/terminals\/(host-[a-f0-9-]{36})\/terminate$/) : null;
  if (!sampling && !listing && !creating && !closing) return new Response("Not found", { status: 404 });
  try {
    if (sampling) {
      const sample = await hostRequest({ operation: "sample", fresh: request.method === "POST" });
      return json ? Response.json(sample) : response(renderSample(sample));
    }
    let selected = url.searchParams.get("selected") ?? undefined;
    if (creating) selected = (await hostRequest({ operation: "create" })).id;
    if (closing) await hostRequest({ operation: "terminate", id: closing[1]! });
    const terminals = await hostRequest({ operation: "list" });
    return json ? Response.json({ selected, terminals }) : response(renderTerminals(terminals, selected));
  } catch (error) {
    const message = String(error);
    const code = sampling ? "host_sample_failed" : listing ? "host_unavailable" : "host_operation_failed";
    if (json) return Response.json({ error: { code, message } }, { status: 502 });
    if (sampling) return response(renderSample(undefined, message));
    const retry = actionLinkHtml({ href: "/host/terminals", variant: "secondary", content: { kind: "caption", caption: listing ? "Retry" : "Back to terminals" }, attributesHtml: `data-turbo-frame="${terminalFrame}"` });
    return response(`<turbo-frame id="${terminalFrame}">${failure(message)}${retry}</turbo-frame>`);
  }
}
/** Host targets Kintsugi System, not a Workspace or necessarily the physical Docker host. */
export const kintsugiServerModule: WorkspaceModule = {
  id: "host",
  settingsContributions: [{ id: "host", label: "Host", order: 80, render: async () => hostAvailable() ? `<div class="host-content"><turbo-frame id="${statsFrame}" src="/host/sample"><p role="status">Sampling host…</p></turbo-frame><turbo-frame id="${terminalFrame}" src="/host/terminals"><p role="status">Loading terminals…</p></turbo-frame></div>` : `<p>Host access requires an Kintsugi System image with the host service. This instance has no Host connection.</p>` }],
  initialize(context) { context.registerSocketHandler(hostTerminalSocket); },
  routes: [{ handle }],
  openApiPaths: hostOpenApiPaths,
  staticFiles: { ...observableTerminalStaticFiles, "/host.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
};
