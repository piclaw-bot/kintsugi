import { readInlineContent } from "./inline-content.ts";
import { inlineContentDocument } from "./inline-content-document.ts";
import type { WorkspaceModuleRouteHandler } from "@kintsugi/shared";

export const handleInlineContentRequest: WorkspaceModuleRouteHandler["handle"] = async (request, url) => {
  const params = url.pathname.match(/^\/workspaces\/([a-zA-Z0-9_-]+)\/inline-content$/);
  if (!params || request.method !== "GET") return undefined;
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  const path = url.searchParams.get("path");
  if (!path?.startsWith("/") || path.includes("\0")) return new Response("An absolute file path is required.", { status: 400, headers });
  const fragment = await readInlineContent(params[1]!, path);
  if ("error" in fragment) return new Response(fragment.error, { status: 422, headers });
  return new Response(await inlineContentDocument(fragment.html), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
};
