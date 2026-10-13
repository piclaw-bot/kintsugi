import { Controller } from "@hotwired/stimulus";
import { setToggleValue } from "@kintsugi/design-system/toggle/client";
import { workspaceTemplateSecretAllowsPath } from "@kintsugi/workspace-templates/secret-path-policy";
import { workspaceTemplateSecretDefaultHosts } from "@kintsugi/workspace-templates/secret-host-defaults";

/** New-secret defaults: well-known names suggest their hosts until the user types one,
 *  and the path permission follows the host until the user explicitly picks one. */
export class WorkspaceTemplateNewSecretController extends Controller<HTMLFormElement> {
  static targets = ["name", "host", "permission", "toggle"];
  declare readonly nameTarget: HTMLInputElement;
  declare readonly hostTarget: HTMLInputElement;
  declare readonly permissionTarget: HTMLInputElement;
  declare readonly toggleTarget: HTMLElement;
  private chosen = false;
  private suggestedHost = "";

  connect(): void {
    this.chosen = this.element.hasAttribute("data-secret-path-chosen");
    this.useDefault();
    this.element.addEventListener("reset", this.resetChoice);
  }

  disconnect(): void { this.element.removeEventListener("reset", this.resetChoice); }

  private readonly resetChoice = (): void => {
    this.chosen = false;
    this.element.removeAttribute("data-secret-path-chosen");
    queueMicrotask(() => this.useDefault());
  };

  suggestHost(): void {
    if (this.hostTarget.value !== "" && this.hostTarget.value !== this.suggestedHost) return;
    this.suggestedHost = workspaceTemplateSecretDefaultHosts(this.nameTarget.value) ?? "";
    this.hostTarget.value = this.suggestedHost;
    this.useDefault();
  }

  useDefault(): void {
    if (this.chosen) return;
    const value = String(workspaceTemplateSecretAllowsPath({ hostPattern: this.hostTarget.value }));
    this.permissionTarget.value = value;
    setToggleValue(this.toggleTarget, value);
  }

  choose(event: Event): void {
    // The design-system toggle emits change for keyboard/selection changes,
    // but a click on the already-selected choice is also an explicit decision.
    if (event.type === "click" && !(event.target instanceof Element && event.target.closest('button[name="allowInPath"]'))) return;
    this.chosen = true;
    this.element.setAttribute("data-secret-path-chosen", "");
  }
}
