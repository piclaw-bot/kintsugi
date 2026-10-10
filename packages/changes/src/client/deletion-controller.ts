import type { FileDiff, FileDiffMetadata } from "@pierre/diffs";
import type { WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { changesDiffOptions } from "@kintsugi/syntax/diff-options";

export function createDeletionReviewController(Controller: WorkspaceClientControllerConstructor) {
  return class DeletionReviewController extends Controller {
    static targets = ["diff"];
    private instances: FileDiff<never>[] = [];
    private hydratedHosts = new WeakSet<HTMLElement>();

    requestFile(event: Event): void {
      if (!(event.currentTarget instanceof HTMLDetailsElement)) throw new Error("Deletion review loading requires details");
      if (!event.currentTarget.open) return;
      const frame = event.currentTarget.querySelector<HTMLElement>(":scope > .disclosure-content > turbo-frame[data-src]")!;
      if (!frame.hasAttribute("src")) frame.setAttribute("src", frame.dataset.src!);
    }

    diffTargetConnected(host: HTMLElement): void {
      void this.hydrateHost(host);
    }

    disconnect(): void {
      for (const instance of this.instances) instance.cleanUp();
      this.instances = [];
    }

    private async hydrateHost(host: HTMLElement): Promise<void> {
      if (this.hydratedHosts.has(host)) return;
      const [{ FileDiff }] = await Promise.all([import("@pierre/diffs"), import("@kintsugi/syntax/pierre")]);
      if (!host.isConnected || this.hydratedHosts.has(host)) return;
      this.hydratedHosts.add(host);
      const script = host.querySelector<HTMLScriptElement>("script[data-deletion-model]")!;
      // SAFETY: The deletion file endpoint emits this private diff model.
      const model = JSON.parse(script.textContent!) as { fileDiff: FileDiffMetadata };
      const container = host.querySelector<HTMLElement>("diffs-container")!;
      const template = container.querySelector<HTMLTemplateElement>(":scope > template[shadowrootmode]");
      const prerenderedHTML = template?.innerHTML;
      template?.remove();
      const instance = new FileDiff<never>({ ...changesDiffOptions, overflow: "wrap" });
      instance.hydrate({ fileContainer: container, fileDiff: model.fileDiff, lineAnnotations: [], prerenderedHTML });
      this.instances.push(instance);
    }
  };
}
