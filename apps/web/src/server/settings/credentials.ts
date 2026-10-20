import { KintsugiCoreError, invalidArguments, readJsonObject, requestAcceptsJson } from "@kintsugi/core";
import { escapeHtml, errorMessage } from "@kintsugi/shared";
import { jsonResponse, response, stream, replace, wantsStream } from "@kintsugi/shared/http";
import { buttonHtml } from "@kintsugi/design-system/button";
import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { listInstanceCredentials, saveInstanceCredential, deleteInstanceCredential, listWorkspaceTemplates, parseInstanceCredentialInput, type InstanceCredentialInput, type InstanceCredentialSummary } from "@kintsugi/workspace-templates";

const base = "/settings/credentials";
const field = (label: string, name: string, value: string, attrs = "") => `<label class="settings-field"><span class="settings-field-label">${escapeHtml(label)}</span><input class="text-field" name="${name}" value="${escapeHtml(value)}" ${attrs}></label>`;
const save = (caption: string) => buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption } });
export async function renderCredentialSettings(error = "", saved = false): Promise<string> {
  const { credentials, audit } = await listInstanceCredentials();
  const { workspaceTemplates } = await listWorkspaceTemplates();
  function editor(credential?: InstanceCredentialSummary): string {
    const id = credential?.id;
    const grants = workspaceTemplates.map(template => `<label class="settings-field"><span><input type="checkbox" name="templateIds" value="${escapeHtml(template.id)}"${credential?.templateIds.includes(template.id) ? " checked" : ""}> ${escapeHtml(template.name)}</span></label>`).join("");
    const typeOptions = ["token", "password", "secret"].map(type => `<option value="${type}"${(credential?.type ?? "token") === type ? " selected" : ""}>${type}</option>`).join("");
    return `<form method="post" action="${base}${id ? `/${encodeURIComponent(id)}` : ""}" data-turbo="true" autocomplete="off">
      ${credential ? `<input type="hidden" name="expectedRevision" value="${credential.revision}">` : ""}
      ${field("Name", "name", credential?.name ?? "", 'required maxlength="120"')}
      ${field("Environment variable", "envName", credential?.envName ?? "", 'required pattern="[A-Z_][A-Z0-9_]*" maxlength="120" placeholder="SERVICE_TOKEN"')}
      ${field("Description (visible to granted agents)", "description", credential?.description ?? "", 'maxlength="1000"')}
      <label class="settings-field"><span class="settings-field-label">Type</span><select class="settings-select popup-select" data-controller="popup-select" name="type">${typeOptions}</select></label>
      ${field("Allowed hosts", "hostPattern", credential?.hostPattern ?? "", 'required maxlength="2000" placeholder="api.github.com"')}
      <p>Exact DNS names, separated by commas. HTTPS on port 443 only. Network restrictions still apply. Use placeholders in request headers; URL paths need the separate permission below.</p>
      ${field(id ? "Replace secret value" : "Secret value", "secretValue", "", `type="password" autocomplete="new-password" data-1p-ignore maxlength="65536"${id ? "" : " required"}`)}
      <p>${id ? "Leave blank to keep the value. Re-enter it when changing the variable, hosts or path permission." : "Stored encrypted. Agents and workspace processes receive only an opaque placeholder."}</p>
      <label class="settings-field"><span><input type="checkbox" name="enabled" value="true"${!credential || credential.enabled ? " checked" : ""}> Enabled</span></label>
      <label class="settings-field"><span><input type="checkbox" name="allowInPath" value="true"${credential?.allowInPath ? " checked" : ""}> Allow substitution in URL paths</span></label>
      <p>Enable path substitution only if the service requires it. Query-string substitution is never allowed.</p>
      <fieldset><legend>Available to templates</legend>${grants || "Add a workspace template before granting access."}</fieldset>
      <p>Access applies to every process in workspaces created from these templates, not just one agent. No access for empty workspaces or future templates.</p>
      ${save(id ? "Save changes" : "Add credential")}</form>
      ${id ? `<form method="post" action="${base}/${encodeURIComponent(id)}/delete" data-turbo="true"><p>Deleting revokes all ${credential.templateIds.length} template ${credential.templateIds.length === 1 ? "grant" : "grants"}. Requests already admitted cannot be recalled.</p>${destructiveConfirmationHtml({ id: `credential_delete_${id}`, trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Delete credential" } }, confirmCaption: "Delete credential", cancelCaption: "Cancel" })}</form>` : ""}`;
  }
  const rows = credentials.map(credential => disclosureHtml({ summary: { kind: "compact", width: "fit", label: { kind: "text", text: credential.name } }, bodyHtml: `<p>${escapeHtml(credential.envName)} · ${credential.enabled ? "Enabled" : "Disabled"} · ${credential.templateIds.length} template ${credential.templateIds.length === 1 ? "grant" : "grants"}</p><p>Last proxy use: ${escapeHtml(credential.lastUsedAt ?? "Never")}. This records credential resolution, not upstream success.</p>${editor(credential)}` })).join("");
  const recent = audit.slice(-10).reverse().map(event => `<li>${escapeHtml(event.at)} · ${escapeHtml(credentials.find(item => item.id === event.credentialId)?.name ?? event.credentialId)} · ${escapeHtml(event.action)}</li>`).join("");
  return `<section class="settings-sec" id="credential_settings"><p>Store a credential once, then grant it to selected templates. Secret values are never returned. Existing global and template secrets keep their current behaviour.</p>
    ${error ? `<p class="settings-error" role="alert">${escapeHtml(error)} Secret values have not been retained in this form.</p>` : saved ? '<p role="status">Saved. Rotation and revocation apply to subsequent requests. New grants appear in the agent credential catalogue immediately; environment variables are added to newly created workspaces.</p>' : ""}
    ${rows}${disclosureHtml({ summary: { kind: "compact", width: "fit", label: { kind: "text", text: "Add credential" } }, bodyHtml: editor() })}
    <p>Back up projects.json and project-secrets.key together. The key is stored separately from the catalogue, but in the same app data volume; protect that volume and its backups.</p>
    ${recent ? `<details><summary>Recent changes</summary><ul>${recent}</ul></details>` : ""}</section>`;
}
async function input(request: Request): Promise<InstanceCredentialInput> {
  if (request.headers.get("content-type")?.includes("application/json")) return parseInstanceCredentialInput(await readJsonObject(request));
  const form = await request.formData();
  const values = { name: String(form.get("name") ?? ""), envName: String(form.get("envName") ?? ""), description: String(form.get("description") ?? ""), type: String(form.get("type") ?? "token"),
    hostPattern: String(form.get("hostPattern") ?? ""), enabled: form.get("enabled") === "true", allowInPath: form.get("allowInPath") === "true", templateIds: form.getAll("templateIds").map(String),
  };
  if (form.has("expectedRevision")) Object.assign(values, { expectedRevision: Number(form.get("expectedRevision")) });
  const value = { ...values, secretValue: String(form.get("secretValue") ?? "") };
  return parseInstanceCredentialInput(value.secretValue ? value : values);
}
export async function handleCredentialSettings(request: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/settings\/credentials(?:\/([^/]+)(\/delete)?)?$/);
  if (!match) return;
  if (request.method === "GET" && !match[1] && requestAcceptsJson(request)) return jsonResponse(await listInstanceCredentials());
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  try {
    const id = match[1] && decodeURIComponent(match[1]);
    if (match[2] && !id) throw invalidArguments("Credential ID is required");
    const credential = match[2] ? await deleteInstanceCredential(id!) : await saveInstanceCredential(id, await input(request));
    if (requestAcceptsJson(request)) return jsonResponse(match[2] ? { credential, deleted: true } : { credential });
    return wantsStream(request) ? stream(replace("credential_settings", await renderCredentialSettings("", true))) : Response.redirect(new URL("/settings?section=credentials", request.url), 303);
  } catch (error) {
    if (!(error instanceof KintsugiCoreError)) throw error;
    if (requestAcceptsJson(request)) return jsonResponse({ error: { code: error.code, message: errorMessage(error) } }, { status: 400 });
    const html = await renderCredentialSettings(errorMessage(error));
    return wantsStream(request) ? stream(replace("credential_settings", html), { status: 422 }) : response(html, { status: 422 });
  }
}
