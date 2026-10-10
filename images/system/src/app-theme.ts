import { readFile } from "node:fs/promises";
import { parseThemeSettings, type KintsugiTheme } from "../../../packages/shared/src/theme.ts";

// The app owns this persisted setting. System reads it independently so its pages
// match the app even while the app is stopped or updating.
export async function readAppTheme(): Promise<KintsugiTheme> {
  const text = await readFile("/data/app/theme.json", "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  return parseThemeSettings(text, "nord");
}
