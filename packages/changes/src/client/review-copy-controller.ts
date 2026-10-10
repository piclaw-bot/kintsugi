import { copyTextToClipboard, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { showButtonConfirmation } from "@kintsugi/design-system/button-confirmation/client";
import type { CommentVersion } from "../server/comments.ts";

export function createReviewCopyController(Controller: WorkspaceClientControllerConstructor) {
  return class ReviewCopyController extends Controller {
    static targets = ["model", "button", "error"];
    static values = { workspaceId: String };
    declare readonly workspaceIdValue: string;
    declare readonly modelTarget: HTMLScriptElement;
    declare readonly buttonTarget: HTMLButtonElement;
    declare readonly errorTarget: HTMLElement;
    async copy(): Promise<void> {
      // SAFETY: The server owns this clipboard bundle and its exact comment revisions.
      const model = JSON.parse(this.modelTarget.textContent!) as { text: string; versions: CommentVersion[] };
      const button = this.buttonTarget;
      button.disabled = true;
      this.errorTarget.hidden = true;
      try {
        await copyTextToClipboard(model.text);
      } catch (error) {
        this.errorTarget.textContent = "Couldn’t copy comments. Try again.";
        this.errorTarget.hidden = false;
        button.disabled = false;
        console.error(error);
        return;
      }
      showButtonConfirmation(button);
      try {
        const data = new FormData();
        data.set("versions", JSON.stringify(model.versions));
        const result = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/changes/comments/copied`, { method: "POST", body: data, headers: { Accept: "text/vnd.turbo-stream.html" } });
        if (!result.ok) throw new Error(await result.text());
        window.Turbo!.renderStreamMessage(await result.text());
      } catch (error) {
        this.errorTarget.textContent = "Comments were copied, but we couldn’t record it. Copy again before deleting this workspace.";
        this.errorTarget.hidden = false;
        console.error(error);
      } finally { button.disabled = false; }
    }
  };
}
