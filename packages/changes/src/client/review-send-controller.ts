import { agentComposerSendPromptEvent, type AgentComposerSendPromptDetail, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";

export function createReviewSendController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static targets = ["button", "preview", "feedback", "notDelivered", "error", "response"];
    static values = { workspaceId: String, key: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly keyValue: string;
    declare readonly buttonTarget: HTMLButtonElement;
    declare readonly previewTarget: HTMLElement;
    declare readonly feedbackTarget: HTMLElement;
    declare readonly notDeliveredTarget: HTMLInputElement;
    declare readonly errorTarget: HTMLElement;
    declare readonly responseTarget: HTMLElement;
    private busy = false;
    private dialog() { return this.previewTarget.querySelector<HTMLDialogElement>("dialog"); }
    private root() { return this.element.closest<HTMLElement>("[data-workspace-selected-agent]"); }
    private status(message: string) { this.errorTarget.textContent = message; this.errorTarget.hidden = false; }
    private async post(operation: string, input: { agentId?: string; id?: string; status?: "queued" | "uncertain"; confirmAbsent?: boolean }) {
      const operationId = crypto.randomUUID();
      const response = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/changes/review-delivery/${operation}`, { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html", "Content-Type": "application/json" }, body: JSON.stringify({ key: this.keyValue, operationId, ...input }) });
      const body = await response.text();
      if (!response.ok) throw new Error(body || `Request failed (${response.status})`);
      await new Promise<void>((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (this.responseTarget.textContent !== operationId) return;
          observer.disconnect(); clearTimeout(timer); resolve();
        });
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error("The view did not update. Refresh Changes and check delivery before trying again.")); }, 5000);
        observer.observe(this.responseTarget, { childList: true, subtree: true, characterData: true });
        window.Turbo!.renderStreamMessage(body);
      });
    }
    private async run(operation: () => Promise<void>) {
      if (this.busy) return;
      this.busy = true; this.buttonTarget.disabled = true; this.errorTarget.hidden = true;
      try { await operation(); }
      catch (error) { this.status(error instanceof Error ? error.message : String(error)); }
      finally { this.busy = false; this.buttonTarget.disabled = false; }
    }
    async preview() {
      await this.run(async () => {
        const loading = this.element.closest('[data-controller~="changes-diff-endpoints"]')?.querySelector<HTMLElement>('[data-changes-diff-endpoints-target="loading"]');
        if (loading && !loading.hidden) throw new Error("Wait for the comparison to finish, then preview the comments.");
        const agentId = this.root()?.dataset.workspaceSelectedAgent;
        if (!agentId) throw new Error("Select an Agent before sending comments.");
        await this.post("prepare", { agentId }); this.dialog()?.showModal();
      });
    }
    cancel() { this.dialog()?.close(); }
    async confirm() {
      await this.run(async () => {
        const dialog = this.dialog(), id = dialog?.dataset.batchId;
        if (!id) throw new Error("Preview the comments before sending.");
        // Capture the confirmed recipient before any await; later tab switches do not retarget it.
        const selected = dialog.dataset.agentId;
        const composer = selected ? this.root()?.querySelector(`[data-workspace-pane-role="agent"][data-workspace-pane-id="${CSS.escape(selected)}"] .composer`) : undefined;
        if (!composer) throw new Error("Open the selected Agent’s composer before sending comments.");
        dialog.close();
        await this.post("begin", { id });
        const model = this.previewTarget.querySelector<HTMLScriptElement>('[data-review-send-target="outbox"]');
        if (!model) throw new Error("Delivery could not be confirmed. Use Check delivery before trying again.");
        // SAFETY: This is the server-owned immutable batch, not user-entered tool arguments.
        const outbox = JSON.parse(model.textContent!) as { id: string; agentId: string; text: string };
        if (outbox.id !== id || outbox.agentId !== selected) throw new Error("The recipient changed. Use Check delivery before trying again.");
        let status: "queued" | "uncertain" = "queued";
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Delivery acknowledgement timed out")), 60000);
            composer.dispatchEvent(new CustomEvent<AgentComposerSendPromptDetail>(agentComposerSendPromptEvent, { bubbles: true, detail: { text: outbox.text, requestId: id, onComplete: error => { clearTimeout(timer); if (error) reject(error); else resolve(); } } }));
          });
        } catch { status = "uncertain"; }
        // An acknowledgement failure is also uncertain, never an automatic retry.
        try { await this.post("ack", { id, status }); }
        catch (error) { throw new Error(`Delivery is uncertain. Check the Agent before retrying: ${error instanceof Error ? error.message : String(error)}`); }
      });
    }
    async check(event: Event) {
      // SAFETY: Stimulus binds this action to the server-rendered delivery button.
      const id = (event.currentTarget as HTMLElement).dataset.batchId;
      await this.run(async () => { await this.post("check", { id }); this.dialog()?.showModal(); });
    }
    async markNotDelivered() {
      if (!this.notDeliveredTarget.reportValidity()) return;
      const id = this.dialog()?.dataset.batchId;
      await this.run(async () => { await this.post("not-delivered", { id, confirmAbsent: this.notDeliveredTarget.checked }); });
    }
  };
}
