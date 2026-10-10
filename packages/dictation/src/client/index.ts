import type { WorkspaceClientModule } from "@kintsugi/shared";
import { createDictationComposerController } from "./dictation-controller.ts";
import { SharedMicrophone } from "./microphone.ts";

const sharedMicrophone = new SharedMicrophone();
const dictationButtonSelector = '[data-dictation-composer-target="button"]';

function activeDictationButton(): HTMLButtonElement | null {
  const dialogButton = document.querySelector<HTMLButtonElement>(`dialog[open] ${dictationButtonSelector}`);
  if (dialogButton) return dialogButton;
  const activeAgentButton = document.querySelector<HTMLButtonElement>(`.workspace-detail-resident.visible [data-workspace-logically-visible="true"] ${dictationButtonSelector}`);
  if (activeAgentButton) return activeAgentButton;
  return [...document.querySelectorAll<HTMLButtonElement>(dictationButtonSelector)]
    .find((button) => button.getClientRects().length > 0) ?? null;
}

export const kintsugiClientModule: WorkspaceClientModule = {
  id: "dictation",
  install({ application, Controller, hooks }) {
    application.register("dictation-composer", createDictationComposerController(Controller, sharedMicrophone));
    hooks.registerCommand({
      id: "dictation.toggle",
      label: "Start or stop dictation",
      description: "Toggle microphone dictation in the active composer.",
      scope: "agent",
      binding: "Meta+Alt+Backslash",
      run: () => activeDictationButton()?.click(),
    });
  },
};
