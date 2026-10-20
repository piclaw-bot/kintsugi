import { attributesHtml } from "../html.ts";
import { contentRowClasses, contentRowContentHtml } from "./content-row-markup.ts";

export interface ContentRowElement {
  tag: "a" | "button" | "div" | "span";
  /** Trusted integration attributes. No class or style; escape external values. */
  attributesHtml?: string;
}

export interface ContentRowLabel {
  kind: "text";
  text: string;
  attributesHtml?: string;
  textAttributesHtml?: string;
}

interface ContentRowSlots {
  label: ContentRowLabel;
  /** Trusted leading visuals, never a replacement for the label. */
  leadingHtml?: string;
  /** Trusted trailing status or metadata. */
  trailingHtml?: string;
  /** Muted for secondary rows such as explanations; it brightens on hover like any row. */
  tone?: "default" | "muted" | "danger";
  /** Fit the contents by default; fill the allocated lane for collection rows. */
  width?: "fit" | "fill";
}

/** Presentation is explicit, not inferred from text length or viewport geometry. */
export type ContentRowContent = ContentRowSlots & (
  | { kind: "compact"; description?: never }
  | { kind: "multiline"; description?: string }
);

type ContentRowInteraction =
  | { element: ContentRowElement; primary?: boolean }
  | {
      element?: never;
      container?: { attributesHtml?: string };
      primary: ContentRowElement;
      /** Separately actionable leading controls; do not nest them in the primary. */
      leadingActionsHtml?: string;
      /** Controls revealed on hover, keyboard focus, or touch. */
      engagedActionsHtml?: string;
    };

export type ContentRowOptions = ContentRowContent & ContentRowInteraction;

function elementHtml(element: ContentRowElement, className: string, content: string): string {
  return `<${element.tag} class="${className}"${attributesHtml(element.attributesHtml)}>${content}</${element.tag}>`;
}

/** Menu entries, navigation, informational rows and primary actions share one anatomy. */
export function contentRowHtml(options: ContentRowOptions): string {
  const content = contentRowContentHtml(options);
  if (options.element) {
    return elementHtml(options.element, contentRowClasses(options, true, options.primary !== false), content);
  }
  const primary = elementHtml(options.primary, "content-row__primary", content);
  const actions = options.engagedActionsHtml ? `<div class="content-row__actions content-row__actions--engaged" data-controller="content-row-actions">${options.engagedActionsHtml}</div>` : "";
  const leading = options.leadingActionsHtml ? `<div class="content-row__actions content-row__actions--leading">${options.leadingActionsHtml}</div>` : "";
  return `<div class="${contentRowClasses(options, false, false)}"${attributesHtml(options.container?.attributesHtml)}>${leading}${primary}${actions}</div>`;
}

/** Browser-owned interactions use the same renderer as server HTML. */
export function contentRowElement<T extends HTMLElement = HTMLElement>(options: ContentRowOptions): T {
  const template = document.createElement("template");
  template.innerHTML = contentRowHtml(options);
  const element = template.content.firstElementChild;
  if (!(element instanceof HTMLElement)) throw new Error("Content row renderer did not produce an HTML element");
  // SAFETY: The caller chooses T to match the element tag supplied in the same options object.
  return element as T;
}
