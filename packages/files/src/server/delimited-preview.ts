import { escapeHtml as h } from "@kintsugi/shared";
import { response } from "@kintsugi/shared/http";
import { DelimitedParseError, isDelimitedPath, parseDelimitedPreview, type DelimitedPreview } from "../delimited.ts";
import { EditableFileError, maxEditableFileBytes } from "./editable-file.ts";

function renderTable(table: DelimitedPreview): string {
  const rows = table.rows.length, columns = table.headers.length;
  const warnings = [table.truncatedRows ? "First 500 rows" : "", table.truncatedColumns ? "First 80 columns" : "", table.truncatedCells ? "Long cells shortened" : ""].filter(Boolean);
  const head = table.headers.map(cell => `<th scope="col">${h(cell)}</th>`).join("");
  const body = table.rows.map((row, index) => `<tr data-table-preview-target="row"><th scope="row">${index + 1}</th>${row.map(cell => `<td>${h(cell)}</td>`).join("")}</tr>`).join("");
  return `<section class="delimited-preview" data-controller="table-preview"><header class="delimited-preview-toolbar"><label>Filter rows <input class="text-field" type="search" maxlength="1000" data-table-preview-target="filter" data-action="input->table-preview#filter" placeholder="Search this preview"></label><span role="status" data-table-preview-target="summary">${rows} ${rows === 1 ? "row" : "rows"} · ${columns} ${columns === 1 ? "column" : "columns"}${warnings.length ? ` · ${warnings.join(" · ")}` : ""}</span></header>${columns ? `<div class="delimited-preview-grid"><table><thead><tr><th aria-label="Row number"></th>${head}</tr></thead><tbody>${body}</tbody></table></div>` : '<p class="empty-state">This file is empty.</p>'}</section>`;
}
export async function renderDelimitedRequest(request: Request, path: string): Promise<Response> {
  if (!isDelimitedPath(path)) throw new EditableFileError("Choose a CSV or TSV file.", 415);
  const chunks: Uint8Array[] = []; let size = 0;
  if (request.body) for await (const chunk of request.body) { size += chunk.byteLength; if (size > maxEditableFileBytes) throw new EditableFileError("Table previews are limited to 2 MB.", 413); chunks.push(chunk); }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new EditableFileError("Table previews need UTF-8 text.", 415); }
  try { return response(renderTable(parseDelimitedPreview(text, path)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { if (error instanceof DelimitedParseError) throw new EditableFileError(error.message, 422); throw error; }
}
