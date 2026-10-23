export function formatShortcutBinding(binding: string): string {
  return binding.split("+").map((part) => {
    switch (part) {
      case "Meta": return "⌘";
      case "Alt": return "⌥";
      case "Control": return "⌃";
      case "Shift": return "⇧";
      case "Comma": return ",";
      case "Period": return ".";
      case "Slash": return "/";
      case "Quote": return "'";
      case "Semicolon": return ";";
      case "Backslash": return "\\";
      case "Backspace": return "⌫";
      case "BracketRight": return "]";
      default: return part.replace(/^Key/, "");
    }
  }).join("");
}
