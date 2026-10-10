import { Type } from "typebox";
import { Value } from "typebox/value";

/** App-wide Themes shared across open pages. design-system.css defines each one as a [data-theme] rule. */
export const kintsugiThemes = [
  { id: "daylight", label: "Daylight", appearance: "light" },
  { id: "cappuccino", label: "Cappuccino", appearance: "dark" },
  { id: "tokyo-night", label: "Tokyo Night", appearance: "dark" },
  { id: "midnight", label: "Midnight", appearance: "dark" },
  { id: "nord", label: "Nord", appearance: "dark" },
] as const;

export type KintsugiTheme = (typeof kintsugiThemes)[number]["id"];

export function isKintsugiTheme(value: unknown): value is KintsugiTheme {
  return kintsugiThemes.some((theme) => theme.id === value);
}

export function themeAppearance(theme: KintsugiTheme): "light" | "dark" {
  return kintsugiThemes.find(({ id }) => id === theme)!.appearance;
}

const themeSettingsSchema = Type.Object({ theme: Type.Optional(Type.String()) });

/** Parse the app's theme.json, which Kintsugi System also reads. `undefined` means no file. */
export function parseThemeSettings(text: string | undefined, fallback: KintsugiTheme): KintsugiTheme {
  const settings: unknown = text === undefined ? {} : JSON.parse(text);
  if (!Value.Check(themeSettingsSchema, settings)) throw new Error("Invalid theme settings");
  // A theme removed by a later release must not break page rendering.
  return isKintsugiTheme(settings.theme) ? settings.theme : fallback;
}
