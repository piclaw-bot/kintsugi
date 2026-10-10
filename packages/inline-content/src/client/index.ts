import type { WorkspaceClientModule } from "@kintsugi/shared";
import { createInlineContentController } from "./inline-content-controller.ts";

export const kintsugiClientModule: WorkspaceClientModule = {
  id: "inline-content",
  install({ application, Controller }) {
    application.register("inline-content", createInlineContentController(Controller));
  },
};
