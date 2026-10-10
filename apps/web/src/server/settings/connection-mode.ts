import { existsSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { toggleHtml } from "@kintsugi/design-system/toggle";
import { buttonHtml } from "@kintsugi/design-system/button";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { accessModeSchema, proxyAccessSchema } from "@kintsugi/shared";
import { escapeHtml } from "@kintsugi/shared";
import { kintsugiUrlHtml } from "../kintsugi-url.ts";
import { response } from "@kintsugi/shared/http";

// The System access API and marker retain their existing protocol spelling.
export const connectionModeManaged = () => existsSync("/run/kintsugi-system/access-v1");
const schema = Type.Object({ mode: accessModeSchema, proxy: Type.Optional(proxyAccessSchema), connectionState: Type.String(), authUrl: Type.Optional(Type.String()), origin: Type.Optional(Type.String()), error: Type.Optional(Type.String()) });
export async function renderConnectionModeSettings(): Promise<string> {
  if (!connectionModeManaged()) return "";
  const status = await fetch("http://127.0.0.1:3001/access");
  if (!status.ok) throw new Error(`System access status: ${status.status}`);
  const access = Value.Parse(schema, await status.json());
  const remote = access.mode === "tailscale";
  const modeToggle = toggleHtml({
    variant: "button",
    label: "Where can you use Kintsugi?",
    name: "mode",
    value: access.mode,
    form: { action: "/settings/access" },
    options: [
      { value: "localhost", label: "Installation computer only" },
      { value: "tailscale", label: "Devices on your Tailscale network" },
      ...(access.proxy ? [{ value: "proxy", label: "Trusted LAN proxy" }] : []),
    ],
  });
  const connected = remote && access.connectionState === "Running";
  const connectionAction = !remote || connected ? "" : access.authUrl
    ? actionLinkHtml({ href: access.authUrl, variant: "primary", content: { kind: "caption", caption: "Sign in to Tailscale" }, attributesHtml: 'target="_blank" rel="noreferrer"' })
    : `<form action="/settings/access" method="post"><input type="hidden" name="mode" value="tailscale">${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Retry Tailscale connection" } })}</form>`;
  return `<turbo-frame id="settings_access" data-controller="connection-mode-settings">
    <section class="settings-sec" id="settings-sec-access">
      <div class="settings-choice-row"><h2>Where can you use Kintsugi?</h2>${modeToggle}</div>
      ${access.mode === "proxy" ? "<p>The LAN proxy controls reachability. Everyone who can reach the UI is trusted. Configure origins and ports with the host installer.</p>" : !remote ? "<p>Use Kintsugi and Workspace previews in a browser on the computer where Kintsugi is installed. Tailscale is off.</p>" : ""}
      ${remote && !connected ? "<p>Tailscale isn’t connected yet.</p>" : ""}
      ${access.error ? `<p class="settings-error">${escapeHtml(access.error)}</p>` : ""}
      ${connectionAction}
    </section>
    <section class="settings-sec settings-sec-url" id="settings-sec-url"><h2>Kintsugi URL</h2>${access.origin ? kintsugiUrlHtml(access.origin, "settings_kintsugi_url_qr") : '<p>The URL will appear when the connection is ready.</p>'}</section>
  </turbo-frame>`;
}
export async function handleConnectionModeSettings(request: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/settings/access")) return;
  if (!connectionModeManaged()) return new Response("System access settings are unavailable", { status: 404 });
  if (url.pathname === "/settings/access/events" && request.method === "GET") {
    const upstream = await fetch("http://127.0.0.1:3001/events", { signal: request.signal });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
  if (url.pathname !== "/settings/access") return;
  if (request.method === "POST") {
    const mode = (await request.formData()).get("mode");
    if (mode !== "localhost" && mode !== "tailscale" && mode !== "proxy") return new Response("Invalid access mode", { status: 400 });
    const result = await fetch("http://127.0.0.1:3001/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    if (!result.ok) throw new Error(`System access setting: ${result.status}: ${await result.text()}`);
    return Response.redirect(new URL("/settings/access", url), 303);
  }
  if (request.method === "GET") return response(await renderConnectionModeSettings());
}
