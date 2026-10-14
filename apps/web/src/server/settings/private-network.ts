import { Type } from "typebox";
import { Value } from "typebox/value";
import { parsePrivateNetworkDestination, formatPrivateNetworkDestination } from "@kintsugi/shared/network-destinations";
import { NetworkConfigurationError } from "@kintsugi/shared/network-policy";
import { requestAcceptsJson, readJsonObject } from "@kintsugi/core";
import { errorMessage } from "@kintsugi/shared";
import { jsonResponse } from "@kintsugi/shared/http";
import { globalWorkspaceConfiguration, type ConfigurationScope } from "@kintsugi/workspace-templates";
import { getPrivateNetworkAccess, setPrivateNetworkAccess } from "@kintsugi/workspace-templates/private-network";

export const privateNetworkAccessInput = Type.Object({ privateNetworkAccess: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 128 }) }, { additionalProperties: false });

/** JSON security API. Configuration does not enable any workspace or replace its applied policy. */
export async function handlePrivateNetworkSettings(request: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/(?:workspace-templates\/([^/]+)|global-workspace-settings)\/private-network-access$/);
  if (!match || !requestAcceptsJson(request) && !request.headers.get("content-type")?.includes("application/json")) return;
  const scope: ConfigurationScope = match[1] === undefined ? globalWorkspaceConfiguration : decodeURIComponent(match[1]);
  if (request.method === "GET") return jsonResponse({ privateNetworkAccess: await getPrivateNetworkAccess(scope) });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  if (!request.headers.get("content-type")?.includes("application/json")) return jsonResponse({ error: { code: "invalid_private_network_access", message: "Send a JSON privateNetworkAccess list." } }, { status: 415 });
  const input = await readJsonObject(request);
  if (!Value.Check(privateNetworkAccessInput, input)) return jsonResponse({ error: { code: "invalid_private_network_access", message: "Expected a bounded privateNetworkAccess array of host:port strings." } }, { status: 400 });
  try {
    return jsonResponse({ privateNetworkAccess: await setPrivateNetworkAccess(scope, input.privateNetworkAccess.map(entry => formatPrivateNetworkDestination(parsePrivateNetworkDestination(entry))).join("\n")) });
  } catch (error) {
    if (!(error instanceof NetworkConfigurationError)) throw error;
    return jsonResponse({ error: { code: "invalid_private_network_access", message: errorMessage(error) } }, { status: 400 });
  }
}
