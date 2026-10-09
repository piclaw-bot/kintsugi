/// <reference lib="dom" />
import type { WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";
import { parseEditableFileResponse } from "../protocol.ts";

export function createFilesDiagramController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FilesDiagramController extends Controller {
    static values = { workspaceId: String, contentUrl: String, previewUrl: String };
    static targets = ["preview", "status"];
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly contentUrlValue: string;
    declare readonly previewUrlValue: string;
    declare readonly previewTarget: HTMLElement;
    declare readonly statusTarget: HTMLElement;
    private connection!: AbortController;
    private revision?: string;
    private sequence = 0;
    connect(): void {
      this.connection = new AbortController();
      // SAFETY: The Files refresh signal carries its workspace ID.
      window.addEventListener("agents-in-the-cloud:files-refresh", this.diskChanged as EventListener, { signal: this.connection.signal });
      this.element.addEventListener("agents-in-the-cloud:file-editor-refresh", this.refresh, { signal: this.connection.signal });
      this.refresh();
    }
    disconnect(): void { this.connection.abort(); }
    private diskChanged = (event: CustomEvent<{ workspaceId: string }>): void => {
      if (event.detail.workspaceId === this.workspaceIdValue) this.refresh();
    };
    private refresh = (): void => { void this.load(); };
    private async load(): Promise<void> {
      const sequence = ++this.sequence;
      const { signal } = this.connection;
      const current = (): boolean => !signal.aborted && this.element.isConnected && sequence === this.sequence;
      try {
        const response = await fetch(this.contentUrlValue, { signal, headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) throw new Error(await response.text());
        const file = parseEditableFileResponse(await response.json());
        if (!current()) return;
        if (this.revision !== file.revision) {
          const preview = await fetch(this.previewUrlValue, { method: "POST", signal, headers: { "Content-Type": "application/xml", Accept: "text/html" }, body: file.content });
          if (!preview.ok) throw new Error(await preview.text());
          const html = await preview.text();
          if (!current()) return;
          this.previewTarget.innerHTML = html;
          this.revision = file.revision;
        }
        this.statusTarget.textContent = "";
      } catch (error) {
        if (!current()) return;
        this.statusTarget.textContent = "Unable to preview";
        this.previewTarget.textContent = String(error);
        this.revision = undefined;
      }
    }
  };
}
