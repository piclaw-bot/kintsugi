import { changeLayout } from "@kintsugi/shared";

/** Height available above the arranged keyboard, or the full window when it is down. */
export function composerViewportHeight(): number {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return root.clientHeight - Number.parseFloat(style.getPropertyValue("--software-keyboard-inset") || "0")
    - Number.parseFloat(style.getPropertyValue("--software-keyboard-top") || "0");
}

/** Content-sized editing, bounded by the host's height budget and the controls' minimum. */
export function sizeComposer(composer: HTMLElement, maxComposer: number): void {
  const input = composer.querySelector<HTMLTextAreaElement>(".composer-input")!;
  if (!composer.checkVisibility()) return;
  const area = input.parentElement!;
  const buttons = area.querySelector<HTMLElement>(":scope > .composer-buttons")!;
  const promptTemplateButtons = area.querySelector<HTMLElement>(":scope > .composer-prompt-template-buttons");
  const height = (element: HTMLElement | null): number => element?.checkVisibility() ? element.getBoundingClientRect().height : 0;
  // Everything but the input area: thumbnails, status, footer.
  const chrome = composer.getBoundingClientRect().height - area.getBoundingClientRect().height;
  // Prompt template buttons make way as soon as there is something written.
  const hadText = composer.classList.contains("composer-has-text");
  const hasText = /\S/.test(input.value);
  // Measure without letting the pane reflow: the input area keeps its size,
  // so the transcript above cannot clamp its scroll offset.
  const areaHeight = area.style.height;
  area.style.height = `${area.getBoundingClientRect().height}px`;
  const inline = input.style.height;
  composer.classList.toggle("composer-has-text", hasText);
  input.style.height = "0px";
  const content = Math.ceil(input.scrollHeight);
  const below = height(promptTemplateButtons);
  // Buttons beside the text set its minimum; send floating over it (while typing) doesn't.
  const beside = getComputedStyle(buttons).position === "absolute" ? 0 : height(buttons);
  const minimum = Math.max(Number.parseFloat(getComputedStyle(input).minHeight) || 0, beside - below);
  const limit = Math.max(minimum, maxComposer - chrome - below);
  composer.classList.toggle("composer-has-text", hadText);
  input.style.height = inline;
  area.style.height = areaHeight;
  const next = Math.max(minimum, Math.min(content, limit));
  const overflow = content > limit ? "auto" : "hidden";
  const current = input.getBoundingClientRect().height;
  if (hasText !== hadText || Math.abs(next - current) >= 0.5 || input.style.overflowY !== overflow) {
    changeLayout(() => {
      composer.classList.toggle("composer-has-text", hasText);
      input.style.height = `${next}px`;
      input.style.overflowY = overflow;
    });
  }
  revealComposerCaret(input);
}

/** Large pastes, history recall and dictation should leave the end caret visible. */
export function revealComposerCaret(input: HTMLTextAreaElement): void {
  if (document.activeElement === input && input.selectionEnd === input.value.length) input.scrollTop = input.scrollHeight;
}

/** Blank editor space is a typing target, but controls keep their native action. */
export function focusComposerText(composer: HTMLElement, event: MouseEvent): void {
  const input = composer.querySelector<HTMLTextAreaElement>(".composer-input")!;
  const target = event.target instanceof Element ? event.target : null;
  if (input.inert || !target || !composer.contains(target) || target === input) return;
  if (target.closest("button, a, input, select, textarea, label, summary, .agent-chip, .composer-footer, .agent-completion-menu-host")) return;
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}
