import { isWorkspacePaneVisible, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { maxOfficeFileBytes, type OfficeKind } from "../office-format.ts";
import { officeThemeTokens, parseOfficeReadyMessage, parseOfficeStatusMessage, type OfficeWireMessage, type OfficeLoadMessage } from "../office-protocol.ts";

export function createOfficePaneController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static targets = ["frame", "status"];
    static values = { dataUrl: String, frameUrl: String, kind: String, name: String };
    declare readonly element: HTMLElement;
    declare readonly frameTarget: HTMLIFrameElement;
    declare readonly statusTarget: HTMLElement;
    declare readonly dataUrlValue: string;
    declare readonly frameUrlValue: string;
    declare readonly kindValue: OfficeKind;
    declare readonly nameValue: string;
    private started = false;
    private ready = false;
    private nonce = "";
    private request?: AbortController;
    private bytes?: ArrayBuffer;
    private port?: MessagePort;
    private timer?: ReturnType<typeof setTimeout>;
    connect() { this.sync(); }
    disconnect() { this.request?.abort(); this.port?.close(); this.port = undefined; clearTimeout(this.timer); this.bytes = undefined; this.started = false; this.ready = false; }
    sync() { if (!this.started && !document.hidden && isWorkspacePaneVisible(this.element)) void this.load(); }
    reload() { this.request?.abort(); this.port?.close(); this.port = undefined; clearTimeout(this.timer); this.started = false; this.ready = false; this.bytes = undefined; this.sync(); }
    private status(text: string, error = false) { this.statusTarget.hidden = false; this.statusTarget.textContent = text; this.statusTarget.classList.toggle("is-error", error); }
    private async load() {
      this.started = true; this.ready = false; const nonce = this.nonce = crypto.randomUUID();
      const request = this.request = new AbortController(); this.status("Loading read-only preview…");
      this.frameTarget.src = `${this.frameUrlValue}?load=${encodeURIComponent(nonce)}#${nonce}`;
      this.timer = setTimeout(() => {
        if (nonce !== this.nonce) return;
        request.abort(); this.port?.close(); this.bytes = undefined; this.frameTarget.src = "about:blank";
        this.status("Preview timed out. Reload or download the file.", true);
      }, 30000);
      try {
        const response = await fetch(this.dataUrlValue, { signal: request.signal });
        if (!response.ok) throw new Error((await response.text()).slice(0, 1000));
        if (!response.body) throw new Error("The file response was empty.");
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
        try {
          for (;;) { const result = await reader.read(); if (result.done) break; length += result.value.byteLength; if (length > maxOfficeFileBytes) { await reader.cancel(); throw new Error("The file exceeds the 16 MiB preview limit."); } chunks.push(result.value); }
        } finally { reader.releaseLock(); }
        if (request.signal.aborted || nonce !== this.nonce) return;
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        this.bytes = bytes.buffer; this.deliver();
      } catch (error) {
        if (request.signal.aborted || nonce !== this.nonce) return;
        clearTimeout(this.timer); this.frameTarget.src = "about:blank";
        this.status(error instanceof Error ? error.message : String(error), true);
      }
    }
    message(event: MessageEvent<OfficeWireMessage>) {
      if (event.source !== this.frameTarget.contentWindow || event.origin !== "null") return;
      const value = parseOfficeReadyMessage(event.data);
      if (!value || value.nonce !== this.nonce) return;
      this.ready = true; this.deliver();
    }
    private deliver() {
      if (!this.ready || !this.bytes || this.port) return;
      const channel = new MessageChannel(), port = this.port = channel.port1;
      port.onmessage = (event: MessageEvent<OfficeWireMessage>) => {
        if (this.port !== port) return;
        const message = parseOfficeStatusMessage(event.data);
        if (!message) return;
        clearTimeout(this.timer); this.status(message.message, message.phase === "error"); this.statusTarget.hidden = message.phase === "ready";
      };
      const computed = getComputedStyle(this.element), theme: Record<string, string> = {};
      for (const token of officeThemeTokens) theme[token] = computed.getPropertyValue(token).trim().slice(0, 256);
      const payload: OfficeLoadMessage = { type: "office-load", nonce: this.nonce, kind: this.kindValue, name: this.nameValue.slice(0, 256), bytes: this.bytes, theme };
      // Opaque origins require '*'. The receiver verifies parent, nonce and a single port;
      // the reply channel carries bounded status text only, never host commands.
      this.frameTarget.contentWindow!.postMessage(payload, "*", [channel.port2, this.bytes]);
      this.bytes = undefined;
    }
  };
}
