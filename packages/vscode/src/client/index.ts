/// <reference lib="dom" />

import type { WorkspaceClientModule } from "@kintsugi/shared";

function cssVariable(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function addKintsugiThemeParams(url: URL): void {
  url.searchParams.set("kintsugiBg", cssVariable("--bg"));
  url.searchParams.set("kintsugiPanel", cssVariable("--panel"));
  url.searchParams.set("kintsugiElev", cssVariable("--elev"));
  url.searchParams.set("kintsugiText", cssVariable("--text"));
  url.searchParams.set("kintsugiLine", cssVariable("--line"));
  url.searchParams.set("kintsugiAccent", cssVariable("--accent"));
}

export const vscodeClientModule: WorkspaceClientModule = {
  id: "vscode",
  install({ application, Controller, hooks }) {
    class VSCodeStartingController extends Controller {
      declare readonly element: HTMLIFrameElement;

      connect(): void {
        this.element.addEventListener("load", this.loaded);
      }

      disconnect(): void {
        this.element.removeEventListener("load", this.loaded);
      }

      private loaded = (): void => {
        this.element.closest(".vscode-frame-shell")?.classList.remove("vscode-loading");
      };
    }

    class VSCodeNavigateController extends Controller {
      static values = { viewId: String, path: String, delivered: Boolean };
      declare readonly viewIdValue: string;
      declare readonly pathValue: string;
      declare readonly deliveredValue: boolean;
      private observer?: MutationObserver;

      connect(): void {
        // The presentation stream activates the view; its body may still be loading.
        this.observer = new MutationObserver(() => this.navigate());
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.navigate();
      }

      disconnect(): void {
        this.observer?.disconnect();
      }

      private navigate(): void {
        const frame = document.getElementById(this.viewIdValue)?.querySelector("iframe");
        if (!frame) return;
        this.observer!.disconnect();
        // The server already handed the file to the live VS Code windows. A
        // loaded frame keeps its workbench: reloading it costs a full download.
        // A frame still loading (perhaps only just activated) takes the file along.
        if (this.deliveredValue && !frame.closest(".vscode-frame-shell")!.classList.contains("vscode-loading")) return;
        // Navigate the existing frame, rather than removing it, so VS Code can
        // run its normal shutdown/backup handling for unsaved editors.
        frame.setAttribute("data-workspace-app-frame-initial-path-value", this.pathValue);
      }
    }

    application.register("vscode-navigate", VSCodeNavigateController);
    application.register("vscode-starting", VSCodeStartingController);
    hooks.onWorkspaceAppFrameUrl(({ appKey, url }) => {
      if (appKey !== "vscode") return;
      addKintsugiThemeParams(url);
    });
    hooks.onWorkspaceAppFrameRefresh(({ appKey, frame, load }) => {
      if (appKey === "vscode" && frame.src) load();
    });
  },
};

export { vscodeClientModule as kintsugiClientModule };
