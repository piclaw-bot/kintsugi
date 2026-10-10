import type { ContentRowLabel } from "@kintsugi/design-system/content-row";
import type { DisclosureSummary } from "@kintsugi/design-system/disclosure";
import { preloadDiffHTML } from "@pierre/diffs/ssr";
import { escapeHtml, formatBytes } from "@kintsugi/shared";
import type { ChangesFile, ChangesFileStats } from "./diff.ts";
import { changesDiffOptions } from "@kintsugi/syntax/pierre";

function jsonForHtml<Value>(value: Value): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
}

function renderSpecialFile(file: ChangesFile): string {
  const description = file.kind === "binary"
    ? "Content preview isn’t available for binary files."
    : "This change doesn’t have a text diff to display.";
  return `<div class="deletion-special-file" role="note"><span class="deletion-special-file__visual" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.5h6l4 4V20.5H7zM13 3.5v4h4M9.5 15.5l2-2 1.5 1.5 1.5-1.5"/></svg></span><div class="deletion-special-file__content"><strong>${escapeHtml(file.detail ?? "Preview unavailable")}</strong><span>${description}</span></div></div>`;
}

export function deletionFileSummary(label: ContentRowLabel, metaHtml: string, title?: string): DisclosureSummary {
  return {
    kind: "multiline",
    width: "fill",
    label: {
      ...label,

      attributesHtml: title ? `title="${escapeHtml(title)}"` : undefined,
    },
    trailingHtml: `<span class="content-row__status deletion-file-meta">${metaHtml}</span>`,
    attributesHtml: 'data-linear-navigation-target="item"',
  };
}

export function renderFileStats(counts: ChangesFileStats): string {
  if (!counts.binarySizes) return `<span class="deletion-additions">+${counts.additions}</span><span class="deletion-deletions">−${counts.deletions}</span>`;
  const { before, after } = counts.binarySizes;
  const sizes = [before, after].filter((size): size is number => size !== undefined);
  const title = `Binary file: ${sizes.map((size) => `${size} bytes`).join(" → ")}`;
  return `<span class="deletion-file-size" title="${title}">${sizes.map(formatBytes).join(" → ")}</span>`;
}

export async function renderDeletionFile(frameId: string, file: ChangesFile): Promise<string> {
  const model = `<script type="application/json" data-turbo-eval="false" data-deletion-model>${jsonForHtml({ fileDiff: file.diff })}</script>`;
  const body = file.kind === "text"
    ? `<div class="kintsugi-pierre-host" data-deletion-review-target="diff"><diffs-container><template shadowrootmode="open">${await preloadDiffHTML({ fileDiff: file.diff!, options: changesDiffOptions })}</template></diffs-container>${model}</div>`
    : renderSpecialFile(file);
  return `<turbo-frame id="${escapeHtml(frameId)}"><div class="deletion-file-diff">${body}</div></turbo-frame>`;
}
