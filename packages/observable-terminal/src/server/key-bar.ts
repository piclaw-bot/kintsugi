import { buttonHtml } from "@kintsugi/design-system/button";
import { escapeHtml } from "@kintsugi/shared";

const terminalAccessoryButtons = [
  { key: "up", label: "↑", ariaLabel: "Up arrow" },
  { key: "down", label: "↓", ariaLabel: "Down arrow" },
  { key: "left", label: "←", ariaLabel: "Left arrow" },
  { key: "right", label: "→", ariaLabel: "Right arrow" },
  { key: "control", label: "Ctrl", ariaLabel: "Control for next keystroke" },
  { key: "escape", label: "Esc", ariaLabel: "Escape" },
] as const;

export function renderTerminalKeyBar(controller: string): string {
  const buttons = terminalAccessoryButtons.map(({ key, label, ariaLabel }) =>
    buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: escapeHtml(label), label: ariaLabel }, attributesHtml: `${key === "control" ? `aria-pressed="false" data-${escapeHtml(controller)}-target="control" ` : ""}data-terminal-key="${key}" data-action="mousedown->${escapeHtml(controller)}#preserveTerminalFocus click->${escapeHtml(controller)}#sendAccessoryKey"` })
  ).join("");
  return `<div class="terminal-key-bar" role="toolbar" aria-label="Terminal keys">${buttons}</div>`;
}

