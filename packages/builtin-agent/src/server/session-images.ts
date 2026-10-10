import type { ImageContent } from "@earendil-works/pi-ai";
import { imageMimeByExtension } from "@kintsugi/shared/file-metadata";

const allowedMimeTypes = new Set(Object.values(imageMimeByExtension));
export function sessionImageResponse(part: ImageContent | undefined): Response {
  if (!part || !allowedMimeTypes.has(part.mimeType)) return new Response("not found", { status: 404 });

  const data = Buffer.from(part.data, "base64");
  return new Response(data, { headers: {
    "cache-control": "private, max-age=31536000, immutable",
    "content-length": String(data.byteLength),
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": part.mimeType,
    "x-content-type-options": "nosniff",
  } });
}
