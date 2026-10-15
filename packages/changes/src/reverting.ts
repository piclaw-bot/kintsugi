import type { FileDiffMetadata } from "@pierre/diffs";
import type { CommentAnnotation } from "./comments.ts";
import { canEditFile } from "./editing.ts";
import type { ChangesFile } from "./server/diff.ts";

/** A contiguous run of removed and added lines, addressed by its order in the file diff; unchanged lines separate hunks. */
export interface ChangeBlock { index: number; additionLineIndex: number; additions: number; deletionLineIndex: number; deletions: number }
export interface LineEdit { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }

export type RevertAnnotation = { kind: "revert"; path: string; block: number };
/** Shows an image or video preview in place of a file’s text. */
export type MediaAnnotation = { kind: "media"; path: string };
export type ChangesAnnotation = CommentAnnotation | RevertAnnotation | MediaAnnotation;

export function changeBlocks(diff: FileDiffMetadata): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  for (const hunk of diff.hunks) {
    let previous: ChangeBlock | undefined;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") { previous = undefined; continue; }
      // Pierre may split one run of changed lines into adjacent entries; re-diffing after a revert would join them.
      if (previous) { previous.additions += content.additions; previous.deletions += content.deletions; continue; }
      const { additionLineIndex, additions, deletionLineIndex, deletions } = content;
      blocks.push(previous = { index: blocks.length, additionLineIndex, additions, deletionLineIndex, deletions });
    }
  }
  return blocks;
}

/** Reverting restores the comparison base, so it needs an editable working file with a text base. */
export function canRevertFile(file: ChangesFile): boolean {
  return canEditFile(file) && file.kind === "text" && file.oldContents !== undefined;
}

/** Revert buttons sit on the line above their hunk; a hunk at the top of the file has none, so its button follows it. */
export function revertAnchor(block: ChangeBlock) {
  if (block.additionLineIndex > 0) return { lineNumber: block.additionLineIndex, side: "additions" } as const;
  return block.additions ? { lineNumber: block.additions, side: "additions" } as const : { lineNumber: block.deletions, side: "deletions" } as const;
}

/**
 * The editor edit that puts one change block back to the base. Full-file diffs carry every line with its own
 * terminator, so the replaced range ends after the last added line's newline, or at its end when it has none.
 */
export function revertBlockEdit(diff: FileDiffMetadata, block: ChangeBlock): LineEdit {
  if (diff.isPartial) throw new Error("Change blocks need a full-file diff");
  const last = diff.additionLines[block.additionLineIndex + block.additions - 1];
  const end = block.additions && !last!.endsWith("\n")
    ? { line: block.additionLineIndex + block.additions - 1, character: last!.length }
    : { line: block.additionLineIndex + block.additions, character: 0 };
  return {
    range: { start: { line: block.additionLineIndex, character: 0 }, end },
    newText: diff.deletionLines.slice(block.deletionLineIndex, block.deletionLineIndex + block.deletions).join(""),
  };
}
