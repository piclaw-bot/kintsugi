/// <reference lib="dom" />

/** Dispatched on document before the first change of a layout transaction. */
export const layoutBeforeEvent = "kintsugi:layout-before";
/** Dispatched on document after the last change of a layout transaction. */
export const layoutAfterEvent = "kintsugi:layout-after";

let depth = 0;

/**
 * Applies a composer, keyboard or focus rearrangement as one synchronous step.
 * Scroll containers record their anchors before and restore them after, so the
 * whole page reaches its settled arrangement in the same frame. Nested calls
 * join the outermost transaction.
 */
export function changeLayout(mutate: () => void): void {
  if (depth === 0) document.dispatchEvent(new Event(layoutBeforeEvent));
  depth += 1;
  try {
    mutate();
  } finally {
    depth -= 1;
  }
  if (depth === 0) document.dispatchEvent(new Event(layoutAfterEvent));
}

/**
 * Keeps the content at a scroll container's bottom edge in place while the
 * container's height changes, so a shrinking container pushes its content up.
 * Returns a disposer.
 */
export function anchorScrollBottom(element: HTMLElement, options: { active(): boolean; restored?(): void }): () => void {
  let bottom: number | undefined;
  const before = (): void => {
    bottom = options.active() ? element.scrollTop + element.clientHeight : undefined;
  };
  const after = (): void => {
    if (bottom === undefined) return;
    const top = bottom - element.clientHeight;
    bottom = undefined;
    if (Math.round(top) !== Math.round(element.scrollTop)) element.scrollTop = top;
    options.restored?.();
  };
  document.addEventListener(layoutBeforeEvent, before);
  document.addEventListener(layoutAfterEvent, after);
  return () => {
    document.removeEventListener(layoutBeforeEvent, before);
    document.removeEventListener(layoutAfterEvent, after);
  };
}
