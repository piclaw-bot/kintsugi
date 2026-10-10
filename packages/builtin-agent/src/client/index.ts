import type { WorkspaceClientModule } from "@kintsugi/shared";
import { createAgentNotificationsController } from "./notifications-controller.ts";
import { createAgentPaneController, registerAgentPaneVisibilityHooks } from "./agent-pane.ts";
import { createAgentTurnController } from "./turn-controller.ts";
import { createAgentTermController } from "./terminal-controller.ts";

const builtinAgentClientModule: WorkspaceClientModule = {
  id: "builtin-agent",
  install({ application, Controller, hooks }) {
    application.register("agent-notifications", createAgentNotificationsController(Controller));
    application.register("agent-pane", createAgentPaneController(Controller));
    application.register("agent-turn", createAgentTurnController(Controller));
    application.register("agent-term", createAgentTermController(Controller));
    registerAgentPaneVisibilityHooks(application, hooks);
  },
};
export { builtinAgentClientModule as kintsugiClientModule };
