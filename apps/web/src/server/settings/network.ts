import { Value } from "typebox/value";
import { NetworkConfigurationError, parseNetworkConfiguration, networkModeSchema } from "@kintsugi/shared/network-policy";
import { requestAcceptsJson, readJsonObject } from "@kintsugi/core";
import { escapeHtml, errorMessage, workspaceModuleModalFrameId } from "@kintsugi/shared";
import { response, stream, update, jsonResponse, wantsStream } from "@kintsugi/shared/http";
import { buttonHtml } from "@kintsugi/design-system/button";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { Icons } from "@kintsugi/design-system/icons";
import { getNetworkConfiguration, setNetworkConfiguration, getWorkspaceNetworkMode, getAppliedWorkspaceNetwork, setWorkspaceNetworkMode, workspaceNetworkRestartRequired } from "@kintsugi/workspace";
import type { NetworkConfiguration } from "@kintsugi/shared/network-policy";

const save = () => buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Save" } });
const list = (value: FormDataEntryValue | null) => String(value ?? "").split(/[\s,]+/).filter(Boolean);
export async function renderNetworkSettings(error = "", saved = false): Promise<string> {
  const config = await getNetworkConfiguration();
  return `<section class="settings-sec" id="network_settings"><form method="post" action="/settings/network" data-turbo="true">
    <p>Workspaces have no LAN access unless you enable it for that workspace. Changes below apply when a workspace is restarted.</p>
    ${error ? `<p class="settings-error" role="alert">${escapeHtml(error)}</p>` : saved ? '<p role="status">Saved. Restart LAN-enabled workspaces to apply changes.</p>' : ""}
    <label class="settings-field"><span class="settings-field-label">Local LAN CIDRs</span><textarea class="textarea" name="cidrs" rows="4" placeholder="192.168.1.0/24&#10;fd12:3456::/64">${escapeHtml(config.cidrs.join("\n"))}</textarea></label>
    <p>One subnet per line. Include IPv4 and IPv6 networks you want the Local LAN option to allow.</p>
    <label class="settings-field"><span class="settings-field-label">DNS forwarder addresses</span><textarea class="textarea" name="dns" rows="2" placeholder="192.168.1.1">${escapeHtml(config.dns.join("\n"))}</textarea></label>
    <p>Up to three upstream IP addresses, on port 53. Leave empty to keep Docker’s default DNS. When configured, System runs a workspace-only resolver that retries the next upstream for missing names. Supply an external mDNS bridge for .local names.</p>
    <label class="settings-field"><span class="settings-field-label">DNS search domains</span><input class="text-field" name="search" value="${escapeHtml(config.search.join(" "))}" placeholder="home.arpa"></label>
    ${save()}</form></section>`;
}
async function readConfiguration(request: Request): Promise<NetworkConfiguration> {
  if (request.headers.get("content-type")?.includes("application/json")) return parseNetworkConfiguration(await readJsonObject(request));
  const data = await request.formData();
  return parseNetworkConfiguration({ cidrs: list(data.get("cidrs")), dns: list(data.get("dns")), search: list(data.get("search")) });
}
export async function handleNetworkSettings(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname !== "/settings/network") return;
  if (request.method === "GET" && requestAcceptsJson(request)) return jsonResponse({ network: await getNetworkConfiguration() });
  if (request.method !== "POST") return;
  try {
    const config = await readConfiguration(request);
    await setNetworkConfiguration(config);
    if (requestAcceptsJson(request)) return jsonResponse({ network: await getNetworkConfiguration() });
    return wantsStream(request) ? stream(update("network_settings", await renderNetworkSettings("", true))) : Response.redirect(new URL("/settings?section=network", request.url), 303);
  } catch (error) {
    if (!(error instanceof NetworkConfigurationError)) throw error;
    if (requestAcceptsJson(request)) return jsonResponse({ error: { code: "invalid_network_settings", message: errorMessage(error) } }, { status: 400 });
    const html = await renderNetworkSettings(errorMessage(error));
    return wantsStream(request) ? stream(update("network_settings", html), { status: 422 }) : response(html, { status: 422 });
  }
}
export async function renderWorkspaceNetwork(id: string, title: string, error = ""): Promise<string> {
  const mode = getWorkspaceNetworkMode(id);
  const pending = await workspaceNetworkRestartRequired(id);
  const applied = getAppliedWorkspaceNetwork(id);
  const labels = { off: "Off — public internet only", lan: "Local LAN — configured CIDRs", private: "Routed private networks — RFC1918 and IPv6 ULA" };
  const options = Object.entries(labels).map(([value, caption]) => `<option value="${value}"${mode === value ? " selected" : ""}>${caption}</option>`).join("");
  return dialogHtml({ element: { id: "workspace_network_dialog", attributesHtml: "data-dialog-auto-show" }, iconHtml: Icons.Settings, titleCaption: `Network: ${title}`, bodyHtml: `<form method="post" action="/workspaces/${encodeURIComponent(id)}/network" data-turbo="true">
    ${error ? `<p class="settings-error" role="alert">${escapeHtml(error)}</p>` : ""}
    <label class="settings-field"><span class="settings-field-label">LAN access</span><select name="mode" class="popup-select" data-controller="popup-select">${options}</select></label>
    <p>Applies to every process and agent in this workspace. Other workspaces and Kintsugi management services stay isolated. Tailnet, link-local and multicast traffic are not enabled.</p>
    <p>Configured DNS forwarders enable LAN names and .local resolution through System. With no forwarders, Docker’s default DNS stays in use. Bonjour service browsing is not enabled.</p>
    <p>${pending ? "Restart needed. Park and unpark this workspace to apply changes; parking closes terminal and VS Code views." : "Changes apply after you park and unpark this workspace."} Current access: ${escapeHtml(labels[applied.mode])}.</p>
    <p><a href="/settings?section=network" data-turbo-frame="_top">Installation network settings</a></p>${save()}</form>` });
}
export async function handleWorkspaceNetwork(request: Request, id: string, title: string, modalPage: (html: string) => Promise<Response>): Promise<Response> {
  if (!["GET", "POST"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  let error = "";
  if (request.method === "POST") {
    try {
      const mode = request.headers.get("content-type")?.includes("application/json") ? (await readJsonObject(request)).mode : (await request.formData()).get("mode");
      if (!Value.Check(networkModeSchema, mode)) throw new NetworkConfigurationError("LAN access must be off, lan, or private");
      await setWorkspaceNetworkMode(id, mode);
    } catch (failure) {
      if (!(failure instanceof NetworkConfigurationError)) throw failure;
      error = errorMessage(failure);
    }
  }
  const status = error ? 400 : 200;
  if (requestAcceptsJson(request)) return jsonResponse(error ? { error: { code: "invalid_workspace_network", message: error } } : { network: { mode: getWorkspaceNetworkMode(id), applied: getAppliedWorkspaceNetwork(id), restartRequired: await workspaceNetworkRestartRequired(id) } }, { status });
  const html = await renderWorkspaceNetwork(id, title, error);
  return wantsStream(request) ? stream(update(workspaceModuleModalFrameId, html), { status }) : modalPage(html);
}
