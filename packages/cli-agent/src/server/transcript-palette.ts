/**
 * Kintsugi's opinion on how agent transcripts are drawn, as ANSI palette slots.
 * The terminal maps each slot to the viewer's theme (observable-terminal), so
 * CLI agents recolor live on theme changes. The built-in agent's markdown CSS
 * uses the same design tokens directly.
 */
export const transcriptSlot = {
  /** --panel: subtle surfaces behind messages and tool output. */
  surface: 0,
  /** --danger */
  danger: 1,
  /** --success */
  success: 2,
  /** --warning */
  warning: 3,
  /** --decorative */
  decorative: 5,
  /** --text: prose. */
  text: 7,
  /** --text-muted: secondary text, rules, quotes, comments. */
  muted: 8,
  /** --accent: inline code, links, interactive emphasis. */
  accent: 12,
  /** --text-bright: headings. */
  bright: 15,
} as const;

/** Code block colors, approximating the design system's --syntax-* roles within the palette. */
export const syntaxSlot = {
  comment: transcriptSlot.muted,
  keyword: transcriptSlot.accent,
  function: transcriptSlot.accent,
  type: transcriptSlot.accent,
  string: transcriptSlot.success,
  number: transcriptSlot.decorative,
  variable: transcriptSlot.warning,
} as const;
