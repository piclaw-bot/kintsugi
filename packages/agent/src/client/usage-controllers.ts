import type { WorkspaceClientControllerConstructor } from "@kintsugi/shared";

export function createUsageControllers(Controller: WorkspaceClientControllerConstructor) {
  class UsageSnapshotController extends Controller {
    connect(): void { this.element.dispatchEvent(new CustomEvent("kintsugi:usage:refreshed", { bubbles: true })); }
  }

  class UsageButtonController extends Controller {
    declare readonly element: HTMLElement;
    static targets = ["empty"];
    declare readonly emptyTarget: HTMLTemplateElement;
    private request?: AbortController;
    private timer?: ReturnType<typeof setInterval>;

    connect(): void {
      this.timer = setInterval(this.refresh, 60_000);
      this.refresh();
    }

    disconnect(): void {
      clearInterval(this.timer);
      this.request?.abort();
    }

    readonly refresh = async (): Promise<void> => {
      this.request?.abort();
      if (document.hidden) return;
      const request = new AbortController();
      this.request = request;
      try {
        const response = await fetch("/usage/button", { signal: request.signal, headers: { Accept: "text/vnd.turbo-stream.html" } });
        if (!response.ok) throw new Error(`Could not refresh Usage button: HTTP ${response.status}`);
        const html = await response.text();
        if (request.signal.aborted) return;
        window.Turbo!.renderStreamMessage(html);
      } catch (error) {
        if (request.signal.aborted) return;
        this.element.querySelector("turbo-frame")!.replaceChildren(this.emptyTarget.content.cloneNode(true));
        console.error(error);
      }
    };
  }

  return { "usage-button": UsageButtonController, "usage-snapshot": UsageSnapshotController };
}
