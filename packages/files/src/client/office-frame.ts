import { errorMessage } from "@kintsugi/shared";
import { Application, Controller } from "@hotwired/stimulus";
import { renderAsync } from "docx-preview";
import * as XLSX from "xlsx";
import { PPTXViewer } from "pptxviewjs";
import { officeMimeTypes, type OfficeKind } from "../office-format.ts";
import { parseOfficeLoadMessage, type OfficeWireMessage, type OfficeLoadMessage, type OfficeStatusMessage } from "../office-protocol.ts";

class OfficeDocumentController extends Controller {
  static targets = ["sheets", "slideControls", "previous", "next", "zoom", "info", "content", "word", "grid", "head", "rows", "canvas"];
  declare readonly sheetsTarget: HTMLSelectElement;
  declare readonly slideControlsTarget: HTMLElement;
  declare readonly previousTarget: HTMLButtonElement;
  declare readonly nextTarget: HTMLButtonElement;
  declare readonly zoomTarget: HTMLSelectElement;
  declare readonly infoTarget: HTMLElement;
  declare readonly contentTarget: HTMLElement;
  declare readonly wordTarget: HTMLElement;
  declare readonly gridTarget: HTMLTableElement;
  declare readonly headTarget: HTMLTableSectionElement;
  declare readonly rowsTarget: HTMLTableSectionElement;
  declare readonly canvasTarget: HTMLCanvasElement;
  private port?: MessagePort;
  private kind?: OfficeKind;
  private bytes?: ArrayBuffer;
  private names: string[] = [];
  private slides?: PPTXViewer;
  private rendering = false;
  connect() { if (window.parent !== window) window.parent.postMessage({ type: "office-ready", nonce: location.hash.slice(1) }, "*"); }
  disconnect() { this.port?.close(); this.slides?.destroy(); this.bytes = undefined; }
  receive(event: MessageEvent<OfficeWireMessage>) {
    if (this.port || window.parent === window || event.source !== window.parent || event.ports.length !== 1) return;
    const input = parseOfficeLoadMessage(event.data);
    if (!input || input.nonce !== location.hash.slice(1)) return;
    this.port = event.ports[0];
    for (const [token, value] of Object.entries(input.theme)) document.documentElement.style.setProperty(token, value);
    void this.load(input).catch(error => this.error(errorMessage(error)));
  }
  private report(message: string, phase: OfficeStatusMessage["phase"] = "ready") {
    const text = message.slice(0, 1000); this.infoTarget.textContent = text;
    this.port?.postMessage({ type: "office-status", phase, message: text } satisfies OfficeStatusMessage);
  }
  private error(message: string) { this.report(message, "error"); }
  private async load(input: OfficeLoadMessage) {
    this.kind = input.kind; this.bytes = input.bytes;
    if (input.kind === "docx") {
      this.wordTarget.inert = true; this.wordTarget.hidden = false;
      await renderAsync(input.bytes, this.wordTarget, undefined, { renderAltChunks: false, renderComments: false, renderChanges: false, ignoreFonts: true, useBase64URL: true, experimental: false });
      // Documents cannot turn hyperlinks into management-origin requests or navigation.
      for (const anchor of this.wordTarget.querySelectorAll("a")) if (!anchor.getAttribute("href")?.startsWith("#")) anchor.removeAttribute("href");
      this.wordTarget.inert = false; this.applyZoom(); this.report("DOCX preview · read only");
    } else if (input.kind === "pptx") {
      this.canvasTarget.hidden = false; this.slideControlsTarget.hidden = false;
      this.slides = new PPTXViewer({ canvas: this.canvasTarget, debug: false, enableThumbnails: false, autoRenderFirstSlide: false, autoChartRerenderDelayMs: 0, slideSizeMode: "fit" });
      await this.slides.loadFile(new File([input.bytes], input.name, { type: officeMimeTypes.pptx }));
      if (!this.slides.getSlideCount() || this.slides.getSlideCount() > 200) throw new Error("Presentations need 1–200 slides for preview.");
      await this.renderSlide(0);
    } else {
      const workbook = XLSX.read(input.bytes, { type: "array", bookSheets: true, bookProps: true, bookVBA: false });
      this.names = workbook.SheetNames.slice(0, 128);
      if (workbook.SheetNames.length > 128) throw new Error("Workbook previews are limited to 128 worksheets.");
      if (!this.names.length) throw new Error("This workbook has no worksheets.");
      this.sheetsTarget.replaceChildren(...this.names.map((name, index) => new Option(name.slice(0, 120), String(index))));
      this.sheetsTarget.hidden = this.names.length < 2; this.gridTarget.hidden = false;
      this.renderSheet(0);
    }
  }
  private renderSheet(index: number) {
    if (!this.bytes || !this.kind || !Number.isInteger(index) || index < 0 || index >= this.names.length) throw new Error("Choose a worksheet.");
    const workbook = XLSX.read(this.bytes, { type: "array", dense: true, sheets: index, sheetRows: 500, cellHTML: false, cellStyles: false, cellFormula: false, bookVBA: false, bookDeps: false, raw: this.kind === "csv" || this.kind === "tsv", FS: this.kind === "tsv" ? "\t" : undefined });
    const sheet = workbook.Sheets[this.names[index]!]!;
    const range = XLSX.utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1");
    const lastRow = Math.min(499, range.e.r), lastColumn = Math.min(79, range.e.c);
    const values = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, blankrows: true, defval: "", range: { s: { r: 0, c: 0 }, e: { r: lastRow, c: lastColumn } } });
    const header = document.createElement("tr"); header.append(document.createElement("th"));
    for (let column = 0; column <= lastColumn; column++) { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = XLSX.utils.encode_col(column); header.append(cell); }
    const fragment = document.createDocumentFragment(); let characters = 0, limited = range.e.r > 499 || range.e.c > 79;
    for (const [index, row] of values.entries()) {
      const tr = document.createElement("tr"), number = document.createElement("th"); number.scope = "row"; number.textContent = String(index + 1); tr.append(number);
      for (let column = 0; column <= lastColumn; column++) {
        const cell = document.createElement("td"), value = String(row[column] ?? "");
        const text = value.slice(0, Math.max(0, Math.min(2000, 2_000_000 - characters)));
        cell.textContent = text; characters += text.length; limited ||= text.length < value.length; tr.append(cell);
      }
      fragment.append(tr); if (characters >= 2_000_000) { limited = true; break; }
    }
    this.headTarget.replaceChildren(header); this.rowsTarget.replaceChildren(fragment); this.contentTarget.scrollTop = 0;
    this.applyZoom(); this.report(`${this.names[index]!.slice(0, 120)} · cached values${limited ? " · preview limited to 500 rows, 80 columns and bounded cell text" : ""}`);
  }
  link(event: MouseEvent) {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (anchor && !anchor.getAttribute("href")!.startsWith("#")) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  sheet() { try { this.renderSheet(Number(this.sheetsTarget.value)); } catch (error) { this.error(errorMessage(error)); } }
  async previous() { if (this.slides && !this.rendering) await this.navigate(this.slides.getCurrentSlideIndex() - 1); }
  async next() { if (this.slides && !this.rendering) await this.navigate(this.slides.getCurrentSlideIndex() + 1); }
  private async navigate(index: number) { try { await this.renderSlide(index); } catch (error) { this.error(errorMessage(error)); } }
  private async renderSlide(index: number) {
    if (!this.slides || index < 0 || index >= this.slides.getSlideCount()) return;
    this.rendering = true; this.previousTarget.disabled = true; this.nextTarget.disabled = true; this.zoomTarget.disabled = true;
    try {
      const zoom = this.zoomTarget.value === "fit" ? 1 : Number(this.zoomTarget.value);
      if (!Number.isFinite(zoom) || zoom < 0.1 || zoom > 1.5) throw new Error("Choose a supported preview zoom.");
      const width = Math.min(1536, Math.max(240, Math.min(1024, this.contentTarget.clientWidth - 16)) * zoom), height = Math.round(width * 9 / 16);
      // The library multiplies CSS dimensions by devicePixelRatio internally.
      // Keep the physical backing store bounded, then restore the displayed size.
      const ratio = Math.max(1, window.devicePixelRatio);
      this.canvasTarget.style.width = `${width / ratio}px`; this.canvasTarget.style.height = `${height / ratio}px`; this.canvasTarget.width = Math.round(width); this.canvasTarget.height = height;
      await this.slides.renderSlide(index, this.canvasTarget, { timeout: 15000 });
      this.canvasTarget.style.width = `${width}px`; this.canvasTarget.style.height = `${height}px`;
      this.report(`Slide ${index + 1} of ${this.slides.getSlideCount()} · read only`);
    } finally { this.rendering = false; this.zoomTarget.disabled = false; this.previousTarget.disabled = index <= 0; this.nextTarget.disabled = index >= this.slides.getSlideCount() - 1; }
  }
  zoom() { if (this.slides) { if (!this.rendering) void this.navigate(this.slides.getCurrentSlideIndex()); } else this.applyZoom(); }
  private applyZoom() {
    const target = this.kind === "docx" ? this.wordTarget : this.gridTarget;
    target.style.zoom = "1";
    const value = this.zoomTarget.value === "fit" ? this.kind === "docx" ? Math.min(1, Math.max(0.1, (this.contentTarget.clientWidth - 16) / target.scrollWidth)) : 1 : Number(this.zoomTarget.value);
    if (Number.isFinite(value) && value >= 0.1 && value <= 1.5) target.style.zoom = String(value);
  }
}
const application = Application.start(); application.register("office-document", OfficeDocumentController);
