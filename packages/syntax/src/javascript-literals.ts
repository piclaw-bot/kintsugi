import { codeToTokens } from "@pierre/highlights";
import { kintsugiTheme } from "./theme.ts";

const stringToken = 2;

/**
 * Whether each line of formatted JavaScript `code` starts inside the text of a string or template
 * literal, where its indentation is part of the value, rather than in code or a `${}` expression.
 * Highlights keeps a literal's leading whitespace in its string token, while code indentation is a
 * separate token, so this relies on every code line after the first being indented.
 */
export function javascriptLinesStartingInLiterals(code: string): boolean[] {
  return codeToTokens(code, { lang: "javascript", theme: kintsugiTheme }).tokens
    .map((tokens, line) => line > 0 && tokens[0]?.type === stringToken);
}
