import type { WorkspaceModule } from "@kintsugi/shared";
import { createDictationSocketSession } from "./realtime.ts";
import { dictationSettingsContribution } from "./settings.ts";

const dictationStaticFiles = {
  "/dictation.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
} as const;

export const kintsugiServerModule: WorkspaceModule = {
  id: "dictation",
  staticFiles: dictationStaticFiles,
  settingsContributions: [dictationSettingsContribution],
  initialize(context) {
    context.registerSocketHandler(createDictationSocketSession);
  },
};

export { renderDictationComposerControl, dictationComposerController } from "./composer.ts";
