import { createCliModelSettings, type CliModelSettings } from "@kintsugi/cli-agent/server";
import { piCliModelUnavailableReason } from "./pi-cli-bridge.ts";
import type { JsonObject } from "@kintsugi/core";
import { piModelSetupRequired } from "./auth.ts";

const sharedSettings = createCliModelSettings({
  agentTypeId: "pi", label: "Pi",
  // Pi uses its own abstract thinking levels, not the provider-native efforts.
  mapThinkingLevel: (level) => level,
  unavailableReason: piCliModelUnavailableReason,
});

async function preparePiModelSettings(parameters: JsonObject = {}): Promise<CliModelSettings> {
  const settings = await sharedSettings.prepare(parameters);
  if (!settings.model) throw piModelSetupRequired();
  return settings;
}

export const piModelSettings = { ...sharedSettings, prepare: preparePiModelSettings };
