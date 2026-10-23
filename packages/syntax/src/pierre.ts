import { registerCustomTheme } from "@pierre/diffs";
import { kintsugiTheme, kintsugiThemeName } from "./theme.ts";

registerCustomTheme(kintsugiThemeName, () => Promise.resolve(kintsugiTheme), "zed");

export { changesDiffOptions, toolDiffOptions } from "./diff-options.ts";
