/// <reference lib="dom" />
import { Type } from "typebox";
import { Value } from "typebox/value";
import { previewController } from "./preview-controller.ts";

const messageSchema = Type.Union([Type.Object({ event: Type.Union([Type.Literal("configure"), Type.Literal("init")]) }), Type.Object({ event: Type.Union([Type.Literal("autosave"), Type.Literal("save")]), xml: Type.String() })]);
const fileSchema = Type.Object({ content: Type.String(), revision: Type.String(), writable: Type.Boolean() });
const revisionSchema = Type.Object({ revision: Type.String() });
type EditorAction = { action: "configure"; config: { customCss: string } } | { action: "load"; xml: string; autosave: number } | { action: "status"; message: string; modified: boolean };

import type { WorkspaceClientModule, WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";

function syncFrameTheme(frame: HTMLIFrameElement, element: HTMLElement): void {
  const root = frame.contentDocument!.documentElement;
  const styles = getComputedStyle(element);
  root.dataset.aitcChrome = "";
  root.dataset.aitcAppearance = getComputedStyle(document.documentElement).colorScheme === "dark" ? "dark" : "light";
  root.style.setProperty("--aitc-color-scheme", root.dataset.aitcAppearance);
  for (const token of ["bg", "panel", "elev", "line", "line-strong", "text", "text-bright", "text-muted", "accent", "accent-soft", "font-sans", "radius-control"]) {
    root.style.setProperty(`--aitc-${token}`, styles.getPropertyValue(`--${token}`).trim());
  }
}

function controller(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class DrawioController extends Controller {
    declare readonly element: HTMLElement;
    private content = "";
    private revision = "";
    private pending?: string;
    private saving = false;
    private failed = false;
    private dirty = false;
    private ready = false;
    private theme = new MutationObserver(() => this.syncTheme());
    private syncTheme(): void {
      syncFrameTheme(this.frame(), this.element);
    }
    private async configure(): Promise<void> {
      try {
        const response = await fetch(this.element.dataset.drawioThemeUrl!);
        if (!response.ok) throw new Error(await response.text());
        this.syncTheme();
        this.send({ action: "configure", config: { customCss: await response.text() } });
      } catch (error) { this.status(`Could not configure editor: ${String(error)}`, true); }
    }
    private frame(): HTMLIFrameElement { return this.element.querySelector<HTMLIFrameElement>("[data-drawio-frame]")!; }
    private status(text: string, error = false): void {
      const status = this.element.querySelector<HTMLElement>("[data-drawio-status]")!;
      status.textContent = text;
      status.toggleAttribute("data-error", error);
    }
    private send(message: EditorAction): void { this.frame().contentWindow!.postMessage(JSON.stringify(message), location.origin); }
    connect(): void {
      window.addEventListener("message", this.message);
      window.addEventListener("beforeunload", this.beforeUnload);
      document.addEventListener("submit", this.beforeReplace, true);
      this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    }
    disconnect(): void {
      window.removeEventListener("message", this.message);
      window.removeEventListener("beforeunload", this.beforeUnload);
      document.removeEventListener("submit", this.beforeReplace, true);
      this.theme.disconnect();
    }
    private beforeReplace = (event: Event): void => {
      if (!(event.target instanceof HTMLFormElement)) return;
      const path = new URL(event.target.action).pathname;
      if (path !== this.element.dataset.drawioOpenUrl && path !== this.element.dataset.drawioCloseUrl) return;
      if (!this.dirty) return;
      if (this.saving || !window.confirm("Discard unsaved diagram edits? Download a copy first if you want to keep them.")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (this.saving) this.status("Wait for the current save to finish before replacing or closing this diagram.");
      }
    };
    private beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!this.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    private message = (event: MessageEvent): void => {
      if (event.source !== this.frame().contentWindow || event.origin !== location.origin) return;
      let input: unknown;
      try { input = JSON.parse(event.data); } catch { return; }
      if (!Value.Check(messageSchema, input)) return;
      const message = input;
      if (message.event === "configure") void this.configure();
      if (message.event === "init") { this.syncTheme(); void this.load(); }
      if ((message.event === "autosave" || message.event === "save") && this.ready) {
        this.dirty = true;
        this.content = message.xml;
        this.pending = message.xml;
        void this.save();
      }
    };
    private async load(): Promise<void> {
      this.ready = false;
      try {
        const response = await fetch(this.element.dataset.drawioFileUrl!, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) throw new Error(await response.text());
        const file = Value.Parse(fileSchema, await response.json());
        if (!file.writable) throw new Error("This diagram is read-only. Open it in Files to inspect its source.");
        this.content = file.content;
        this.revision = file.revision;
        this.failed = false;
        this.dirty = false;
        this.pending = undefined;
        this.ready = true;
        this.send({ action: "load", xml: this.content, autosave: 1 });
        this.status("Autosave on");
      } catch (error) { this.status(`Could not load diagram: ${String(error)}`, true); }
    }
    private async save(): Promise<void> {
      if (this.saving || this.failed) return;
      this.saving = true;
      try {
        while (this.pending !== undefined) {
          const content = this.pending;
          this.pending = undefined;
          this.status("Saving…");
          const response = await fetch(this.element.dataset.drawioFileUrl!, {
            method: "PUT", headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ content, revision: this.revision }),
          });
          if (response.status === 409) throw new Error("File changed on disk. Download a copy to keep your edits, or reload from disk to discard them and load the latest version.");
          if (!response.ok) throw new Error(await response.text());
          const result = Value.Parse(revisionSchema, await response.json());
          this.revision = result.revision;
        }
        this.dirty = false;
        this.status("Saved");
        this.send({ action: "status", message: "Saved", modified: false });
      } catch (error) {
        this.failed = true;
        this.status(`Autosave stopped: ${String(error)}`, true);
      } finally { this.saving = false; }
    }
    download(event: Event): void {
      event.preventDefault();
      if (!this.ready) return;
      const url = URL.createObjectURL(new Blob([this.content], { type: "application/vnd.jgraph.mxfile" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = this.element.dataset.drawioFilename!;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    reload(event: Event): void {
      event.preventDefault();
      if (this.saving) { this.status("Wait for the current save to finish before reloading."); return; }
      if (this.dirty && !window.confirm("Discard your unsaved diagram edits and reload the file from disk?")) return;
      void this.load();
    }
  };
}
export const agentsInTheCloudClientModule: WorkspaceClientModule = {
  id: "drawio", install({ application, Controller }) { application.register("drawio", controller(Controller)); application.register("drawio-preview", previewController(Controller, syncFrameTheme)); },
};
