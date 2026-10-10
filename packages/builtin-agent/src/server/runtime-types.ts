import type { KintsugiEventBus } from "@kintsugi/core";

export type AgentLivePresentationListener = (streamHtml: string) => void;
export type AgentLivePresentationSubscription = import("@kintsugi/shared").LiveSubscription;

export interface WorkspaceAgentOptions {
  events?: KintsugiEventBus;
}
