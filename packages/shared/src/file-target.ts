export interface WorkspaceFileTarget {
  path: string;
  line?: number;
  column?: number;
}

function positiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse a link target; path resolution belongs to the workspace open operation. */
export function parseWorkspaceFileTarget(params: URLSearchParams): WorkspaceFileTarget {
  return {
    path: params.get("path") ?? "",
    line: positiveInteger(params.get("line")),
    column: positiveInteger(params.get("column")),
  };
}

// File-shaped plain text: an optional /, ./ or ../ prefix, folders, and a name with a
// letter-led extension, then an optional :line or :line:column.
const fileReferenceSource = String.raw`((?:\/|\.\.?\/)?(?:[^\s<>:"'\`()[\]{},;!?/]+\/)*[^\s<>:"'\`()[\]{},;!?/]+\.[a-zA-Z][\w+-]*)(?::(\d+)(?::(\d+))?)?`;
const embeddedFileReference = new RegExp(String.raw`(?:^|[\s([\`'"=])${fileReferenceSource}(?=$|[\s.)\]}'"\`,;!?])`, "g");
const wholeFileReference = new RegExp(`^${fileReferenceSource}$`);

export interface FileReference extends WorkspaceFileTarget {
  /** Offsets of the reference, including any position suffix, in the searched text. */
  start: number;
  end: number;
}

function fileReference(match: RegExpMatchArray, start: number): FileReference {
  const path = match[1]!;
  const end = start + path.length + (match[2] ? match[2].length + 1 : 0) + (match[3] ? match[3].length + 1 : 0);
  return { path, line: positiveInteger(match[2] ?? null), column: positiveInteger(match[3] ?? null), start, end };
}

/** File references in prose. The path is unresolved; it may not name an existing file. */
export function* fileReferencesIn(text: string): Generator<FileReference> {
  for (const match of text.matchAll(embeddedFileReference)) yield fileReference(match, match.index + match[0].indexOf(match[1]!));
}

/** A file reference that is the whole of `text`, such as the content of inline code. */
export function parseFileReference(text: string): FileReference | undefined {
  const match = text.match(wholeFileReference);
  return match ? fileReference(match, 0) : undefined;
}

export function workspaceFileOpenUrl(workspaceId: string, path: string, position: Omit<WorkspaceFileTarget, "path"> = {}, filesViewId?: string): string {
  const query = new URLSearchParams({ path });
  if (position.line) query.set("line", String(position.line));
  if (position.column) query.set("column", String(position.column));
  if (filesViewId) query.set("filesView", filesViewId);
  const endpoint = filesViewId ? "files-view/open" : "file/open";
  return `/workspaces/${encodeURIComponent(workspaceId)}/${endpoint}?${query}`;
}
