import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { runCommand, withCommandSignal } from "@kintsugi/core";
import { maxOfficeFileBytes, officeFileKind } from "../src/office-format.ts";
import { parseOfficeLoadMessage, parseOfficeReadyMessage, parseOfficeStatusMessage, type OfficeLoadMessage } from "../src/office-protocol.ts";
import { createOfficeView, closeFilesView, deleteFilesViewState, listFilesViews, filesView } from "../src/server/state.ts";
import { createOpenOfficeTool, openOfficeView } from "../src/server/office.ts";
import { officeFrameResponse } from "../src/server/office-frame.ts";
const workspaceTest = test.skipIf(process.platform !== "linux");
const directories: string[] = [], workspaces: string[] = [];
afterEach(async () => { for (const workspace of workspaces.splice(0)) deleteFilesViewState(workspace); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function workspace() { const id = "office-" + crypto.randomUUID(); workspaces.push(id); return id; }
async function directory() { const path = await mkdtemp(join(tmpdir(), "office-read-")); directories.push(path); return path; }
const helper = new URL("../workspace_tools/kintsugi-office-read", import.meta.url).pathname;
async function read(path: string, kind = "docx") {
  return withCommandSignal(AbortSignal.timeout(15000), () => runCommand(["/usr/bin/prlimit", "--as=268435456", "--cpu=5", "--nofile=128", "--", "/usr/bin/python3", helper, path, kind], { maxOutputBytes: maxOfficeFileBytes + 1 }));
}
async function docx(entries: Record<string, string> = { "word/document.xml": "<document>Hello</document>" }) {
  const zip = new JSZip(); for (const [name, value] of Object.entries(entries)) zip.file(name, value, { createFolders: false });
  return Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}
async function fixture(bytes: Uint8Array) { const root = await directory(), path = join(root, "fixture.docx"); await writeFile(path, bytes); return { root, path }; }

test("Office formats are explicit and reject legacy formats unsupported by the chosen libraries", () => {
  for (const extension of ["docx", "xlsx", "xlsm", "xlsb", "xls", "ods", "pptx", "csv", "tsv"] as const) expect(officeFileKind(`/work/report.${extension.toUpperCase()}`)).toBe(extension);
  for (const extension of ["doc", "ppt", "odt", "odp", "rtf", "pdf"]) expect(officeFileKind(`/work/report.${extension}`)).toBeUndefined();
  expect(officeFileKind("/work/a\0.docx")).toBeUndefined(); expect(officeFileKind("/work/a.docx.exe")).toBeUndefined();
});
test("Office panes retain the Files reference protocol and older Files metadata readers accept them", () => {
  const id = workspace(), first = createOfficeView(id, "/work/report.docx");
  expect(createOfficeView(id, "/work/report.docx").id).toBe(first.id);
  const second = createOfficeView(id); expect(second.id).not.toBe(first.id);
  expect(openOfficeView(id, "report.docx")).toEqual({ type: "files", id: first.id });
  expect(openOfficeView(id, "/work/sheet.xlsx", second.id)).toEqual({ type: "files", id: second.id });
  expect(filesView(id, second.id).path).toBe("/work/sheet.xlsx");
  const legacy = Type.Array(Type.Object({ id: Type.String(), path: Type.Optional(Type.String({ pattern: "^/" })), line: Type.Optional(Type.Number()), column: Type.Optional(Type.Number()) }));
  expect(Value.Check(legacy, listFilesViews(id))).toBe(true);
  expect(() => openOfficeView("../escape", "/work/report.docx")).toThrow("workspace identifier");
  expect(() => openOfficeView(id, "/work/old.doc")).toThrow("cannot be previewed");
  closeFilesView(id, first.id); expect(listFilesViews(id).some(view => view.id === first.id)).toBe(false);
});
test("Office presentation tool only opens a scoped view; it neither reads nor edits document bytes", async () => {
  const id = workspace(), opened: string[] = [], tool = createOpenOfficeTool(id, async reference => { opened.push(reference.id); });
  expect(Value.Check(tool.parameters, { file_path: "report.docx", workspaceId: "foreign" })).toBe(false);
  const result = await tool.execute("call", { file_path: "missing-but-valid-name.docx" });
  expect(opened).toHaveLength(1); expect(result.details?.reference).toEqual({ type: "files", id: opened[0] });
  expect(listFilesViews(id).find(view => view.id === opened[0])?.path).toBe("/work/missing-but-valid-name.docx");
});
test("opaque viewer envelopes validate bytes, formats, nonce and status-only capabilities", () => {
  const message: OfficeLoadMessage = { type: "office-load", nonce: crypto.randomUUID(), kind: "docx", name: "report.docx", bytes: new ArrayBuffer(3), theme: { "--bg": "#fff" } };
  expect(parseOfficeLoadMessage(message)).toBe(message);
  expect(parseOfficeLoadMessage({ ...message, kind: "doc" })).toBeUndefined();
  expect(parseOfficeLoadMessage({ ...message, bytes: new ArrayBuffer(maxOfficeFileBytes + 1) })).toBeUndefined();
  expect(parseOfficeLoadMessage({ ...message, theme: { constructor: "bad" } })).toBeUndefined();
  expect(parseOfficeLoadMessage({ ...message, nonce: "forged" })).toBeUndefined();
  expect(parseOfficeReadyMessage({ type: "office-ready", nonce: message.nonce })).toBeDefined();
  expect(parseOfficeStatusMessage({ type: "office-status", phase: "ready", message: "Loaded" })).toBeDefined();
  expect(parseOfficeStatusMessage({ type: "office-status", phase: "ready", message: "Loaded", command: "delete_workspace" })).toBeUndefined();
});
test("viewer response policy denies ambient origins, inline script, network connections, nested frames and forms", async () => {
  const response = await officeFrameResponse(), csp = response.headers.get("content-security-policy")!;
  for (const directive of ["default-src 'none'", "script-src-attr 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "sandbox allow-scripts"]) expect(csp).toContain(directive);
  expect(csp).not.toContain("allow-same-origin"); expect(csp).not.toContain("script-src 'unsafe-inline'"); expect(csp).toContain("script-src 'nonce-");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
workspaceTest("valid stored and deflated Office ZIPs are returned byte-for-byte without extraction", async () => {
  const data = await docx(), f = await fixture(data), result = await read(f.path);
  expect(result.exitCode).toBe(0); expect(result.stdout).toEqual(data); expect(await readFile(f.path)).toEqual(data);
  const raw = new JSZip(); raw.file("word/document.xml", "<document/>", { createFolders: false });
  const stored = Buffer.from(await raw.generateAsync({ type: "uint8array", compression: "STORE" })); await writeFile(f.path, stored);
  expect((await read(f.path)).stdout).toEqual(stored);
});
workspaceTest("Office reads reject missing files, symlinks, directories, FIFOs and oversized input", async () => {
  const f = await fixture(await docx());
  expect((await read(join(f.root, "missing.docx"))).exitCode).toBe(44);
  await symlink(f.path, join(f.root, "link.docx")); expect((await read(join(f.root, "link.docx"))).exitCode).toBe(47);
  expect((await read(f.root)).exitCode).toBe(45);
  const pipe = join(f.root, "pipe.docx"); await runCommand(["mkfifo", pipe]); expect((await read(pipe)).exitCode).toBe(47);
  await writeFile(f.path, Buffer.alloc(maxOfficeFileBytes + 1)); expect((await read(f.path)).exitCode).toBe(47);
});
workspaceTest("CRC corruption, traversal, duplicate names, encryption and unsupported compression are rejected", async () => {
  const cases: Buffer[] = [];
  const corrupt = await docx(); const central = corrupt.indexOf(Buffer.from("PK\x01\x02")); corrupt.writeUInt32LE(0, central + 16); cases.push(corrupt);
  cases.push(await docx({ "word/document.xml": "<doc/>", "../escape": "bad" }));
  const duplicate = await docx({ "word/document.xml": "<doc/>", "word/secondxx.xml": "<doc/>" });
  const from = Buffer.from("word/secondxx.xml"), to = Buffer.from("word/document.xml");
  for (let index = duplicate.indexOf(from); index >= 0; index = duplicate.indexOf(from, index + to.length)) to.copy(duplicate, index); cases.push(duplicate);
  const linked = new JSZip(); linked.file("word/document.xml", "target", { unixPermissions: 0o120777, createFolders: false }); cases.push(Buffer.from(await linked.generateAsync({ type: "uint8array", platform: "UNIX" })));
  const encrypted = await docx(), encCentral = encrypted.indexOf(Buffer.from("PK\x01\x02")); encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6); encrypted.writeUInt16LE(encrypted.readUInt16LE(encCentral + 8) | 1, encCentral + 8); cases.push(encrypted);
  const unsupported = await docx(), compCentral = unsupported.indexOf(Buffer.from("PK\x01\x02")); unsupported.writeUInt16LE(12, 8); unsupported.writeUInt16LE(12, compCentral + 10); cases.push(unsupported);
  for (const data of cases) { const f = await fixture(data), result = await read(f.path); expect(result.exitCode, result.stderr).toBe(47); expect(result.stdout).toHaveLength(0); }
});
workspaceTest("actual deflate expansion is checked independently of dishonest central-directory sizes", async () => {
  const data = await docx({ "word/document.xml": "x".repeat(16 * 1024 * 1024 + 65536) });
  const central = data.indexOf(Buffer.from("PK\x01\x02")); data.writeUInt32LE(1, 22); data.writeUInt32LE(1, central + 24);
  const f = await fixture(data), result = await read(f.path);
  expect(result.exitCode).toBe(47); expect(result.stderr).toContain("Actual Office ZIP expansion"); expect(result.stdout).toHaveLength(0);
}, 20000);
workspaceTest("total ZIP expansion and entry count have independent bounds", async () => {
  const shared = "x".repeat(13 * 1024 * 1024), entries: Record<string, string> = {};
  for (let index = 0; index < 5; index++) entries[index === 0 ? "word/document.xml" : `word/extra${index}.xml`] = shared;
  const f = await fixture(await docx(entries)); expect((await read(f.path)).stderr).toContain("64 MiB");
  const zip = new JSZip(); for (let index = 0; index < 5001; index++) zip.file(`entry${index}`, "");
  await writeFile(f.path, await zip.generateAsync({ type: "uint8array" })); expect((await read(f.path)).stderr).toContain("5,000 ZIP entries");
}, 30000);
workspaceTest("PowerPoint dimensions and slide counts are bounded before renderer admission", async () => {
  const presentation = (width: number, count: number) => `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="${width}" cy="5143500"/><p:sldIdLst>${"<p:sldId/>".repeat(count)}</p:sldIdLst></p:presentation>`;
  const f = await fixture(await docx({ "ppt/presentation.xml": presentation(9144000, 2) })); expect((await read(f.path, "pptx")).exitCode).toBe(0);
  await writeFile(f.path, await docx({ "ppt/presentation.xml": presentation(100000000, 2) })); expect((await read(f.path, "pptx")).stderr).toContain("40-inch");
  await writeFile(f.path, await docx({ "ppt/presentation.xml": presentation(9144000, 201) })); expect((await read(f.path, "pptx")).stderr).toContain("200 slides");
});
workspaceTest("CSV/TSV Office admission shares the 2 MB bound and permission checks", async () => {
  const f = await fixture(Buffer.from("a,b\nx,y")); expect((await read(f.path, "csv")).stdout.toString()).toBe("a,b\nx,y");
  await writeFile(f.path, "x".repeat(2_000_001)); expect((await read(f.path, "csv")).exitCode).toBe(47);
  await chmod(f.path, 0); if (process.getuid?.() !== 0) expect((await read(f.path, "xls")).exitCode).toBe(45);
});
