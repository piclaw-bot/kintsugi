import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { buttonGroupHtml } from "@kintsugi/design-system/button-group";
import { buttonHtml } from "@kintsugi/design-system/button";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { escapeHtml, errorMessage, turboStream, turboStreamResponse, type SettingsContribution } from "@kintsugi/shared";
import { requestAcceptsJson, type JsonObject } from "@kintsugi/core";
import { tokenTelemetry } from "./token-telemetry.ts";
import { telemetryConfigSchema, parseTelemetryConfig, type TelemetryConfig } from "./token-telemetry-types.ts";

const controlsId = "token_telemetry_controls";
export async function renderTokenTelemetrySettings(message = "", error = false, draft?: TelemetryConfig): Promise<string> {
  const status = await tokenTelemetry().status(), config = draft ?? status.config;
  const field = (label: string, input: string) => `<label class="settings-field"><span class="settings-field-label">${label}</span>${input}</label>`;
  const button = (caption: string, action?: string) => buttonHtml({ type: "submit", variant: action ? "secondary" : "primary", content: { kind: "caption", caption }, attributesHtml: action ? `formaction="${action}"` : undefined });
  const discard = status.pendingSeries || status.queuedBatches ? `<form method="post" action="/settings/telemetry/discard"><input type="hidden" name="confirmed" value="true">${destructiveConfirmationHtml({ id: "discard_token_telemetry", trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Discard pending exports" } }, confirmCaption: "Discard pending exports", cancelCaption: "Keep exports" })}</form>` : "";
  return `<section class="settings-sec" id="${controlsId}">
    <p>Export recorded token usage to Graphite using PiClaw’s schema under <code>kintsugi.${escapeHtml(config.instance)}.usage</code>.</p>
    ${message ? `<p class="${error ? "settings-error" : "settings-help"}" role="${error ? "alert" : "status"}">${escapeHtml(message)}</p>` : ""}
    <form method="post" action="/settings/telemetry" autocomplete="off">
      <label class="settings-field"><span class="settings-field-label">Export token usage</span><input type="checkbox" name="enabled" value="true"${config.enabled ? " checked" : ""}></label>
      ${field("Graphite host", `<input class="settings-input text-field" name="host" maxlength="253" value="${escapeHtml(config.host)}" placeholder="graphite.example.net">`)}
      ${field("Carbon TCP port", `<input class="settings-input text-field" type="number" name="port" min="1" max="65535" required value="${config.port}">`)}
      ${field("Instance name", `<input class="settings-input text-field" name="instance" maxlength="80" required value="${escapeHtml(config.instance)}">`)}
      ${field("Export interval (minutes)", `<input class="settings-input text-field" type="number" name="intervalMinutes" min="1" max="60" required value="${config.intervalMinutes}">`)}
      <p class="settings-help">Use a unique, stable instance name. TCP is unencrypted and unauthenticated: use a trusted network. This app-level destination does not grant workspace network access.</p>
      <p class="settings-help">Cache counts include reads and writes; hit percentage is reads ÷ all prompt tokens when those counters are complete. Only counts, percentages, available API-equivalent cost estimates and instance/provider/model labels are sent. Estimates are not subscription charges. Missing counters/costs are omitted. Built-in classifier and image usage keeps its own provider/model identity. Pi usage without reliable model identity is retained under unattributed.pi_*; it is never assigned to the parent model.</p>
      <p class="settings-help">New usage only. Disabled periods are excluded. Pending exports survive restarts; retries retain the original timestamps. Carbon does not acknowledge stored data.</p>
      ${buttonGroupHtml({ orientation: "vertical", semantics: "group", label: "Telemetry actions", itemsHtml: button("Save telemetry settings") + button("Test connection", "/settings/telemetry/test") + actionLinkHtml({ href: "/settings/sections/telemetry", variant: "secondary", content: { kind: "caption", caption: "Refresh status" }, attributesHtml: 'data-turbo-frame="app_settings_section_telemetry"' }) })}
    </form>
    <p class="settings-help" role="status">${status.config.enabled ? "Enabled" : "Disabled"} · Pending series: ${status.pendingSeries} · Queued batches: ${status.queuedBatches} (${status.queuedBytes} bytes) · Last delivery: ${escapeHtml(status.lastSuccess ?? "None")}</p>
    ${status.lastError ? `<p class="settings-error">Last export error: ${escapeHtml(status.lastError)}</p>` : ""}
    ${status.droppedBatches || status.oversizedRows || status.invalidRows ? `<p class="settings-error">Dropped batches: ${status.droppedBatches} · Oversized history rows skipped: ${status.oversizedRows} · Invalid history rows: ${status.invalidRows}. Retry retention is 7 days / 10 MiB.</p>` : '<p class="settings-help">Retry retention: 7 days / 10 MiB.</p>'}
    ${discard}</section>`;
}

export const tokenTelemetrySettingsContribution: SettingsContribution = {
  id: "telemetry", label: "Token telemetry", order: 28,
  render: () => renderTokenTelemetrySettings(),
  async handleAction({ request, url }) {
    if (!/^\/settings\/telemetry(?:\/(?:test|discard))?$/.test(url.pathname)) return;
    const service = tokenTelemetry();
    if (request.method === "GET" && url.pathname === "/settings/telemetry") return Response.json(await service.status(), { headers: { "cache-control": "no-store" } });
    if (request.method !== "POST") return;
    const json = requestAcceptsJson(request) || Boolean(request.headers.get("content-type")?.includes("application/json"));
    let draft: TelemetryConfig | undefined;
    try {
      let message: string;
      if (url.pathname.endsWith("/discard")) {
        const confirmed = json ? (await request.json()).confirmed === true : (await request.formData()).get("confirmed") === "true";
        if (!confirmed) throw new Error("Confirm that pending exports should be discarded.");
        await service.discard(); message = "Pending exports discarded.";
      } else {
        const form = json ? undefined : await request.formData();
        draft = parseTelemetryConfig(form ? { enabled: form.get("enabled") === "true", host: String(form.get("host") ?? ""), port: Number(form.get("port")), instance: String(form.get("instance") ?? ""), intervalMinutes: Number(form.get("intervalMinutes")) } : await request.json());
        if (url.pathname.endsWith("/test")) {
          await service.test(draft); message = "TCP connection succeeded. Carbon does not acknowledge stored metrics. Settings have not been saved.";
        } else { await service.configure(draft); draft = undefined; message = "Telemetry settings saved."; }
      }
      return json ? Response.json({ ...await service.status(), message }, { headers: { "cache-control": "no-store" } }) : turboStreamResponse(turboStream("replace", controlsId, await renderTokenTelemetrySettings(message, false, draft)));
    } catch (error) {
      const message = errorMessage(error);
      return json ? Response.json({ error: { code: "invalid_arguments", message } }, { status: 400, headers: { "cache-control": "no-store" } }) : turboStreamResponse(turboStream("replace", controlsId, await renderTokenTelemetrySettings(message, true, draft)), { status: 422 });
    }
  },
};

// SAFETY: This app-owned TypeBox schema contains only JSON Schema values; the round-trip drops its library symbols.
const telemetryJsonSchema = JSON.parse(JSON.stringify(telemetryConfigSchema)) as JsonObject;
const telemetryJsonResponse = { "200": { description: "Telemetry configuration and status", content: { "application/json": { schema: { type: "object", properties: { config: telemetryJsonSchema, prefix: { type: "string" }, pendingSeries: { type: "integer" }, queuedBatches: { type: "integer" }, queuedBytes: { type: "integer" }, lastSuccess: { type: ["string", "null"] }, lastError: { type: ["string", "null"] }, droppedBatches: { type: "integer" }, oversizedRows: { type: "integer" }, invalidRows: { type: "integer" }, message: { type: "string" } } } } } }, "400": { description: "Invalid settings or failed connection" } };
const telemetryJsonBody = { required: true, content: { "application/json": { schema: telemetryJsonSchema } } };
export const tokenTelemetryOpenApiPaths = {
  "/settings/telemetry": {
    get: { summary: "Inspect token telemetry settings and export status", responses: telemetryJsonResponse },
    post: { summary: "Configure new-only Graphite token usage export", description: "Carbon plaintext TCP; no TLS/authentication. Settings authorise an app-level destination, not workspace egress. Interval sums use kintsugi.<instance>.usage.<provider>.<model>. Missing counters/costs are omitted; cache percentages require complete prompt counters. Pi auxiliary usage uses explicit identity, a single recorded code-mode model, or reserved unattributed.pi_* buckets without guessing the parent model. Pending exports must be delivered or discarded before changing the destination or instance.", requestBody: telemetryJsonBody, responses: telemetryJsonResponse },
  },
  "/settings/telemetry/test": { post: { summary: "Test Carbon TCP connectivity without writing metrics or saving settings", requestBody: telemetryJsonBody, responses: telemetryJsonResponse } },
  "/settings/telemetry/discard": { post: { summary: "Discard pending exports without deleting agent histories", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["confirmed"], properties: { confirmed: { const: true } }, additionalProperties: false } } } }, responses: telemetryJsonResponse } },
} satisfies Record<string, JsonObject>;
