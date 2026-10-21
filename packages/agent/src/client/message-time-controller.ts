import type { WorkspaceClientControllerConstructor } from "@kintsugi/shared";

export function createAgentMessageTimeController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static values = { timestamp: Number };
    declare readonly timestampValue: number;
    declare readonly element: HTMLTimeElement;

    timestampValueChanged(): void {
      const date = new Date(this.timestampValue);
      const label = date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      this.element.textContent = label;
      this.element.title = date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" });
      this.element.parentElement!.setAttribute("aria-label", `Last message: ${label}`);
    }
  };
}
