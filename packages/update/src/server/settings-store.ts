import { kintsugiDataPath, getKintsugiRuntimeContext } from "@kintsugi/core";
import { updateJsonSettings } from "@kintsugi/core/json-settings";
import { readReleaseSettings, selectedReleaseChannel, defaultReleaseSource, activeReleaseSource, trackingReleaseSource, releaseSourceSchema, type ReleaseSource } from "@kintsugi/shared/release-source";
import { Value } from "typebox/value";
import { type UpdateChannel } from "./update-channel.ts";

function settingsPath(): string {
  return kintsugiDataPath(getKintsugiRuntimeContext(), "update.json");
}

export async function readStoredUpdateChannel(): Promise<UpdateChannel | undefined> {
  return selectedReleaseChannel(await readReleaseSettings(settingsPath()));
}

export async function writeStoredUpdateChannel(channel: UpdateChannel): Promise<void> {
  await updateJsonSettings(settingsPath(), settings => {
    settings.releaseSelection = channel;
    if (channel === "custom") {
      settings.releaseSource ??= { ...defaultReleaseSource };
      if (!Value.Check(releaseSourceSchema, settings.releaseSource)) throw new Error("Save a custom source first");
      settings.releaseMode = "custom";
    } else {
      settings.releaseChannel = channel;
      if (settings.releaseSource) { settings.releaseSource = { ...Value.Parse(releaseSourceSchema, settings.releaseSource), appVersion: channel, systemVersion: channel }; settings.releaseMode = "custom"; }
    }
  });
}

export async function readStoredReleaseSource(): Promise<ReleaseSource | undefined> {
  return activeReleaseSource(await readReleaseSettings(settingsPath()));
}
export async function writeStoredReleaseSource(source: ReleaseSource): Promise<void> {
  if (!Value.Check(releaseSourceSchema, source)) throw new Error("Invalid release source");
  await updateJsonSettings(settingsPath(), settings => { settings.releaseSource = trackingReleaseSource(source); settings.releaseMode = "custom"; settings.releaseSelection = "custom"; });
}

export async function readStoredTrackingChannel(): Promise<"stable" | "latest"> {
  return (await readReleaseSettings(settingsPath())).releaseChannel ?? "latest";
}
