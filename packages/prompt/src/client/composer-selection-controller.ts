import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@kintsugi/shared";

export function createComposerSelectionAutosubmitController(Controller: StimulusControllerConstructor) {
  return class ComposerSelectionAutosubmitController extends Controller {
    static values = { formId: String };
    declare readonly formIdValue: string;

    submit(): void {
      document.querySelector<HTMLFormElement>(`#${CSS.escape(this.formIdValue)}`)!.requestSubmit();
    }
  };
}

