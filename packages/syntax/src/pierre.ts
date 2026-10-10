import { getSharedHighlighter, registerCustomCSSVariableTheme } from "@pierre/diffs";
import { kintsugiPierreTheme } from "./diff-options.ts";

registerCustomCSSVariableTheme(kintsugiPierreTheme, {
  foreground: "var(--text-bright)", background: "transparent",
  "token-comment": "var(--syntax-comment)", "token-string": "var(--syntax-string)",
  "token-string-expression": "var(--syntax-string)", "token-keyword": "var(--syntax-keyword)",
  "token-function": "var(--syntax-function)", "token-parameter": "var(--syntax-variable)",
  "token-constant": "var(--syntax-constant)", "token-punctuation": "var(--syntax-punctuation)",
  "token-link": "var(--syntax-attribute)",
}, false);

export { changesDiffOptions, toolDiffOptions } from "./diff-options.ts";

/** Pierre's editor doesn't resolve CSS-variable theme placeholders like its viewer does. */
export async function editorThemeCSS(): Promise<string> {
  const highlighter = await getSharedHighlighter({ themes: [kintsugiPierreTheme], langs: [], preferredHighlighter: "shiki-wasm" });
  const style = document.createElement("span").style;
  return Object.entries(highlighter.getTheme(kintsugiPierreTheme).colorReplacements!).map(([color, replacement]) => {
    // Idle tokens use mixed-case hex; incremental edits serialize the same color through CSSOM.
    style.color = color;
    return `[contenteditable] [data-char]:is([style*="color:${color}" i], [style*="color: ${style.color}" i]) { color: ${replacement} !important; }`;
  }).join("\n");
}
