export const kintsugiPierreTheme = "kintsugi";

const changedLineCSS = `[data-line-type="change-addition"], [data-line-type="change-deletion"] { --mix-light: 80%; --mix-dark: 80%; }`;
export const wordDiffCSS = `[data-line-type="change-addition"] [data-diff-span] { background-color: color-mix(in srgb, var(--diffs-addition-base) 20%, transparent); } [data-line-type="change-deletion"] [data-diff-span] { background-color: color-mix(in srgb, var(--diffs-deletion-base) 20%, transparent); }`;
const changesLayoutCSS = `[data-code] { padding-block: 0; overflow-x: auto; }`;

function diffOptions(presentation: "changes" | "tool") {
  const changes = presentation === "changes";
  return {
    preferredHighlighter: "shiki-wasm" as const,
    theme: kintsugiPierreTheme,
    themeType: "dark" as const,
    diffStyle: "unified" as const,
    overflow: changes ? "wrap" as const : "scroll" as const,
    disableLineNumbers: true,
    disableFileHeader: true,
    hunkSeparators: changes ? "line-info" as const : "simple" as const,
    expansionLineCount: changes ? 40 : 3,
    collapsedContextThreshold: changes ? 6 : 0,
    lineDiffType: changes ? "none" as const : "word-alt" as const,
    stickyHeader: false,
    unsafeCSS: changes ? `${changedLineCSS} ${wordDiffCSS} ${changesLayoutCSS}` : changedLineCSS,
  };
}

export const changesDiffOptions = diffOptions("changes");
export const toolDiffOptions = diffOptions("tool");
