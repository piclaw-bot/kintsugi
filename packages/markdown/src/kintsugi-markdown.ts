import { posix } from "node:path";
import { workspaceFileOpenUrl, workspaceProxyUrl, type WorkspaceFileTarget } from "@kintsugi/shared";

interface MarkdownFileTarget extends WorkspaceFileTarget {
  suffix: string;
}

function workspaceFileTarget(rawHref: string, sourcePath?: string): MarkdownFileTarget | undefined {
  let url: URL | undefined;
  try {
    url = new URL(rawHref);
  } catch {
    if (rawHref.startsWith("#") || rawHref.startsWith("?") || rawHref.startsWith("//")) return undefined;
  }
  if (url) {
    const isFileUrl = url.protocol === "file:" && (url.hostname === "" || url.hostname === "localhost");
    if (!isFileUrl && (url.protocol !== "kintsugi:" || url.hostname !== "file")) return undefined;
  }

  const suffixStart = rawHref.search(/[?#]/);
  const pathname = url?.pathname ?? (suffixStart < 0 ? rawHref : rawHref.slice(0, suffixStart));
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (!path || path.includes("\0")) return undefined;

  const target: MarkdownFileTarget = {
    path: url ? path : posix.resolve(sourcePath ? posix.dirname(sourcePath) : "/work", path),
    suffix: url ? `${url.search}${url.hash}` : suffixStart < 0 ? "" : rawHref.slice(suffixStart),
  };
  for (const name of ["line", "column"] as const) {
    const value = url?.searchParams.get(name);
    if (value && /^\d+$/.test(value)) target[name] = Number(value);
  }
  return target;
}

export function kintsugiFileHref(workspaceId: string, rawHref: string, sourcePath?: string): string | undefined {
  const target = workspaceFileTarget(rawHref, sourcePath);
  return target ? workspaceFileOpenUrl(workspaceId, target.path, target) : undefined;
}

export function workspaceFileImageSrc(workspaceId: string, rawSrc: string, sourcePath?: string): string | undefined {
  const target = workspaceFileTarget(rawSrc, sourcePath);
  return target ? workspaceProxyUrl(workspaceId, "file", target.path) + target.suffix : undefined;
}
