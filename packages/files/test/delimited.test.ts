import { expect, test } from "bun:test";
import { DelimitedParseError, isDelimitedPath, parseDelimitedPreview } from "../src/delimited.ts";
import { renderDelimitedRequest } from "../src/server/delimited-preview.ts";

test("CSV records preserve quoted delimiters, escaped quotes, CRLF and embedded newlines", () => {
  const table = parseDelimitedPreview('\uFEFFname,note,last\r\nAlice,"hello, ""world""\r\nnext",\r\nBob,plain,x', "data.csv");
  expect(table.headers).toEqual(["name", "note", "last"]);
  expect(table.rows).toEqual([["Alice", 'hello, "world"\r\nnext', ""], ["Bob", "plain", "x"]]);
  expect(table.truncatedRows).toBe(false); expect(table.truncatedCells).toBe(false);
});
test("TSV forces tabs; CSV detects consistent semicolon and pipe separators outside quotes", () => {
  expect(parseDelimitedPreview('a\tb\n"x,y"\tz', "file.TSV").rows).toEqual([["x,y", "z"]]);
  expect(parseDelimitedPreview('a;b\n"x,y";z', "file.csv").delimiter).toBe(";");
  expect(parseDelimitedPreview('a|b\nx|y', "file.csv").delimiter).toBe("|");
  expect(isDelimitedPath("report.tab")).toBe(true); expect(isDelimitedPath("report.csv.exe")).toBe(false);
});
test("empty, single-row, blank records and ragged rows retain their cell values", () => {
  expect(parseDelimitedPreview("", "empty.csv").rows).toEqual([]);
  expect(parseDelimitedPreview('""', "empty.csv").rows).toEqual([[""]]);
  expect(parseDelimitedPreview("a,b,", "single.csv").rows).toEqual([["a", "b", ""]]);
  expect(parseDelimitedPreview("a,b\nx\n\ny,z", "ragged.csv").rows).toEqual([["x", ""], ["", ""], ["y", "z"]]);
});
test("unbalanced and stray quotes are reported instead of silently changing data", () => {
  for (const text of ['a,b\n"unfinished', 'a,b\nx"y,z', 'a,b\n"x"suffix,z']) expect(() => parseDelimitedPreview(text, "bad.csv")).toThrow(DelimitedParseError);
});
test("row, column and cell limits are explicit and do not falsely flag exactly 500 data rows", () => {
  const exact = "header\n" + "row\n".repeat(500);
  expect(parseDelimitedPreview(exact, "rows.csv").truncatedRows).toBe(false);
  const rows = parseDelimitedPreview(exact + "extra\n", "rows.csv"); expect(rows.rows).toHaveLength(500); expect(rows.truncatedRows).toBe(true);
  const wide = parseDelimitedPreview("x,".repeat(100000), "wide.csv"); expect(wide.headers).toHaveLength(80); expect(wide.truncatedColumns).toBe(true);
  const long = parseDelimitedPreview("header\n" + "x".repeat(10000), "long.csv"); expect(long.rows[0]![0]).toHaveLength(2000); expect(long.truncatedCells).toBe(true);
});
test("formulas, HTML, script-looking text and prototype names remain ordinary strings", () => {
  const table = parseDelimitedPreview('key,value\n__proto__,=1+1\nconstructor,"<img src=x onerror=alert(1)>"', "inert.csv");
  expect(table.rows).toEqual([["__proto__", "=1+1"], ["constructor", "<img src=x onerror=alert(1)>"]]);
});
test("input and request bounds reject oversized bytes, malformed UTF-8, NULs and unrelated formats", async () => {
  expect(() => parseDelimitedPreview("x".repeat(2_000_001), "large.csv")).toThrow("2 MB");
  expect(() => parseDelimitedPreview("a\0b", "bad.csv")).toThrow("NUL");
  const request = (body: string | Uint8Array<ArrayBuffer>) => new Request("http://localhost/table", { method: "POST", body });
  await expect(renderDelimitedRequest(request("é".repeat(1_000_001)), "large.csv")).rejects.toMatchObject({ status: 413 });
  await expect(renderDelimitedRequest(request(new Uint8Array([0xc3, 0x28])), "bad.csv")).rejects.toMatchObject({ status: 415 });
  await expect(renderDelimitedRequest(request("x"), "not.csv.exe")).rejects.toMatchObject({ status: 415 });
  await expect(renderDelimitedRequest(request('"unfinished'), "bad.csv")).rejects.toMatchObject({ status: 422 });
  const response = await renderDelimitedRequest(request("a,b\nx,y"), "valid.csv"); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
});
