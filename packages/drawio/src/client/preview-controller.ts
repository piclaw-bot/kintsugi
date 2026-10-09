/// <reference lib="dom" />
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";

type PreviewAction = { action: "configure"; config: { customCss: string } } | { action: "load"; xml: string; autosave: number } | { action: "fit"; border: number; maxScale: number };

const messageSchema = Type.Object({ event: Type.Union([Type.Literal("configure"), Type.Literal("init"), Type.Literal("load")]) });

export function previewController(Controller: WorkspaceClientControllerConstructor, syncTheme: (frame: HTMLIFrameElement, element: HTMLElement) => void): WorkspaceClientControllerConstructor {
  return class DrawioPreviewController extends Controller {
    static values = { pages: Array };
    declare readonly element: HTMLElement;
    declare readonly pagesValue: string[];
    private page = 0;
    private ready = false;
    private loaded = false;
    private resize = new ResizeObserver(() => this.fit());
    private theme = new MutationObserver(() => { if (this.ready) syncTheme(this.frame(), this.element); });
    private frame(): HTMLIFrameElement { return this.element.querySelector<HTMLIFrameElement>("[data-drawio-frame]")!; }
    private status(): HTMLElement { return this.element.querySelector<HTMLElement>("[data-drawio-preview-status]")!; }
    private send(message: PreviewAction): void { this.frame().contentWindow!.postMessage(JSON.stringify(message), location.origin); }
    connect(): void {
      window.addEventListener("message", this.message);
      this.resize.observe(this.frame());
      this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    }
    disconnect(): void {
      window.removeEventListener("message", this.message);
      this.theme.disconnect();
      this.resize.disconnect();
    }
    private message = (event: MessageEvent): void => {
      if (event.source !== this.frame().contentWindow || event.origin !== location.origin) return;
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!Value.Check(messageSchema, message)) return;
      if (message.event === "configure") void this.configure();
      if (message.event === "init") {
        this.ready = true;
        syncTheme(this.frame(), this.element);
        this.loadPage();
      }
      if (message.event === "load") {
        this.loaded = true;
        this.fit();
        this.status().hidden = true;
      }
    };
    private async configure(): Promise<void> {
      try {
        const response = await fetch("/drawio-editor-theme.css");
        if (!response.ok) throw new Error(await response.text());
        syncTheme(this.frame(), this.element);
        this.send({ action: "configure", config: { customCss: await response.text() } });
      } catch (error) { this.status().textContent = `Could not load preview: ${String(error)}`; }
    }
    private fit(): void {
      if (this.loaded && this.frame().clientWidth > 0 && this.frame().clientHeight > 0) this.send({ action: "fit", border: 24, maxScale: 1 });
    }
    private loadPage(): void {
      if (!this.ready) return;
      this.loaded = false;
      this.status().hidden = false;
      this.send({ action: "load", xml: this.pagesValue[this.page], autosave: 0 });
    }
    selectPage(event: Event & { readonly currentTarget: HTMLButtonElement }): void {
      this.select(Number(event.currentTarget.dataset.drawioPreviewPage));
    }
    navigatePages(event: KeyboardEvent & { readonly currentTarget: HTMLButtonElement }): void {
      const tabs = this.tabs();
      const index = tabs.indexOf(event.currentTarget);
      let next: number;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      this.select(next);
      tabs[next]!.focus();
    }
    private tabs(): HTMLButtonElement[] { return Array.from(this.element.querySelectorAll<HTMLButtonElement>("[data-drawio-preview-page]")); }
    private select(page: number): void {
      this.page = page;
      this.tabs().forEach((tab, index) => {
        tab.setAttribute("aria-selected", String(index === page));
        tab.tabIndex = index === page ? 0 : -1;
      });
      this.loadPage();
    }
  };
}
