import { focusLikelyOpensSoftwareKeyboard, isApplePlatform, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";

/** Append the platform's send shortcut to the composer placeholder; the server cannot know the viewer's platform. */
export function createComposerSendHintController(Controller: WorkspaceClientControllerConstructor) {
  return class ComposerSendHintController extends Controller {
    declare readonly element: HTMLTextAreaElement;

    // Runs once per element, unlike connect(), so moving the textarea never appends twice.
    initialize(): void {
      if (focusLikelyOpensSoftwareKeyboard()) return;
      this.element.placeholder += ` - ${isApplePlatform() ? "Cmd+Return" : "Ctrl+Return"} to send`;
    }
  };
}
