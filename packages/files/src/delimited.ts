/*
 * Adapted from rcarmo/piclaw runtime/web/src/ui/delimited-preview.ts (e31d6143).
 * Copyright (c) 2026 Rui Carmo. MIT License.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export type Delimiter = "," | "\t" | ";" | "|";
export const maxDelimitedRows = 500, maxDelimitedColumns = 80, maxDelimitedCellCharacters = 2000, maxDelimitedCharacters = 2_000_000;
export const isDelimitedPath = (path: string): boolean => /\.(?:csv|tsv|tab)$/i.test(path);
export interface DelimitedPreview {
  headers: string[]; rows: string[][]; delimiter: Delimiter;
  truncatedRows: boolean; truncatedColumns: boolean; truncatedCells: boolean;
}
export class DelimitedParseError extends Error {}
function inferDelimiter(text: string): Delimiter {
  const candidates: Delimiter[] = [",", "\t", ";", "|"];
  const counts = new Map(candidates.map(delimiter => [delimiter, [0]]));
  let quoted = false, row = 0;
  for (let index = 0; index < Math.min(8192, text.length) && row < 10; index++) {
    const ch = text[index];
    if (ch === '"') { if (quoted && text[index + 1] === '"') index++; else quoted = !quoted; }
    else if (!quoted && (ch === "\n" || ch === "\r")) { if (ch === "\r" && text[index + 1] === "\n") index++; row++; for (const values of counts.values()) values.push(0); }
    else if (!quoted) for (const delimiter of candidates) if (ch === delimiter) counts.get(delimiter)![row]!++;
  }
  let best: Delimiter = ",", score = -1;
  for (const delimiter of candidates) {
    const values = counts.get(delimiter)!.filter(value => value > 0);
    if (!values.length) continue;
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const next = mean * values.filter(value => Math.abs(value - mean) < 1).length;
    if (next > score) { score = next; best = delimiter; }
  }
  return best;
}

/** Parse bounded UTF-8-decoded data; formulas and markup remain inert strings. */
export function parseDelimitedPreview(input: string, path: string): DelimitedPreview {
  if (input.length > maxDelimitedCharacters) throw new DelimitedParseError("Table previews are limited to 2 MB.");
  if (input.includes("\0")) throw new DelimitedParseError("Table previews need UTF-8 text without NUL bytes.");
  const text = input.replace(/^\uFEFF/, ""), delimiter = /\.(?:tsv|tab)$/i.test(path) ? "\t" : inferDelimiter(text);
  const records: string[][] = [];
  let row: string[] = [], field = "", column = 0, width = 0, quoted = false, afterQuote = false, atStart = true;
  let truncatedColumns = false, truncatedCells = false;
  const append = (ch: string) => { atStart = false; if (field.length < maxDelimitedCellCharacters) field += ch; else truncatedCells = true; };
  const pushField = () => { if (column < maxDelimitedColumns) row.push(field); else truncatedColumns = true; column++; field = ""; atStart = true; afterQuote = false; };
  const pushRow = () => { pushField(); width = Math.max(width, row.length); records.push(row); row = []; column = 0; };
  for (let index = 0; index < text.length && records.length < maxDelimitedRows + 2; index++) {
    const ch = text[index]!;
    if (quoted) {
      if (ch !== '"') append(ch);
      else if (text[index + 1] === '"') { append('"'); index++; }
      else { quoted = false; afterQuote = true; }
    } else if (ch === delimiter) pushField();
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[index + 1] === "\n") index++; pushRow(); }
    else if (ch === '"' && atStart && !afterQuote) { quoted = true; atStart = false; }
    else if (afterQuote || ch === '"') throw new DelimitedParseError("A quoted field is malformed. Switch to Source to inspect it.");
    else append(ch);
  }
  if (quoted) throw new DelimitedParseError("A quoted field is unfinished. Switch to Source to inspect it.");
  if (row.length || column || field || afterQuote) pushRow();
  const normalized = records.map(record => { const next = record.slice(); while (next.length < width) next.push(""); return next; });
  const hasHeader = normalized.length > 1 && normalized[0]!.some(cell => cell.trim());
  const headers = hasHeader ? normalized.shift()! : Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  return { headers, rows: normalized.slice(0, maxDelimitedRows), delimiter, truncatedRows: normalized.length > maxDelimitedRows, truncatedColumns, truncatedCells };
}
