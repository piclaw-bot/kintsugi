import { prepareCodexSession } from "./session.ts";
import { createCliAgentModule, emptyAgentInput, createCliModelSettings } from "@kintsugi/cli-agent/server";
import { createPiModelRuntime, installSubscriptionCli, requireProviderSubscription } from "@kintsugi/llm/server";
import { providerBrandIconHtml } from "@kintsugi/shared";
import { codexLaunchScript } from "./launch-command.ts";
import { loadCodexTranscript, loadCodexTranscriptImage, codexResumeId, codexHistoryFiles } from "./transcript.ts";

export const codexCliModelSettings = createCliModelSettings({
  agentTypeId: "codex-cli", provider: "openai-codex", label: "Codex CLI",
  mapThinkingLevel: (level, mapped) => mapped === null ? undefined : mapped ?? (level === "off" ? "none" : level),
});

export const kintsugiServerModule = createCliAgentModule({
  id: "codex-cli", label: "Codex CLI", iconHtml: providerBrandIconHtml("openai"),
  requireSetup: async () => requireProviderSubscription(await createPiModelRuntime(), "openai-codex", "Codex"),
  settings: codexCliModelSettings,
  prepareWorkspace: async (workspaceId) => installSubscriptionCli(workspaceId, await createPiModelRuntime()),
  prepareSession: prepareCodexSession,
  launchScript: codexLaunchScript,
  resumeScript: async (workspaceId, settings, session) => codexLaunchScript(emptyAgentInput(), [], settings, session, await codexResumeId(workspaceId, session.id)),
  loadTranscript: loadCodexTranscript,
  loadTranscriptImage: loadCodexTranscriptImage,
  historyFiles: codexHistoryFiles,
});
