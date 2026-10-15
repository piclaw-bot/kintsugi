import { parser } from "@lezer/javascript";

/**
 * Whether each line of JavaScript `code` starts inside the text of a string or template literal,
 * where its indentation is part of the value, rather than in code or a `${}` expression.
 */
export function javascriptLinesStartingInLiterals(code: string): boolean[] {
  const tree = parser.parse(code);
  const starts = [false];
  for (let index = code.indexOf("\n"); index >= 0; index = code.indexOf("\n", index + 1)) {
    const position = index + 1;
    let inLiteral = false;
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(position, 1); node; node = node.parent) {
      if (node.name === "Interpolation") break;
      if ((node.name === "TemplateString" || node.name === "String") && node.from < position && position < node.to) { inLiteral = true; break; }
    }
    starts.push(inLiteral);
  }
  return starts;
}
