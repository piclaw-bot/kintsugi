import { escapeHtml } from "@kintsugi/shared";
import type { ContentRowContent } from "../content-row/content-row-html.ts";
import { contentRowClasses, contentRowContentHtml } from "../content-row/content-row-markup.ts";
import { attributesHtml } from "../html.ts";
import { Icons } from "../icons/icons-html.ts";

export type DisclosureSummary = ContentRowContent & {
  /** Integration attributes on the native summary, such as focus/navigation targets. */
  attributesHtml?: string;
};

export interface DisclosureOptions {
  element?: { id?: string; attributesHtml?: string };
  summary: DisclosureSummary;
  /** Trusted server-rendered contents. Disclosure owns their gutter and spacing. */
  bodyHtml: string;
  /** Integration attributes on the guttered region, e.g. a stable Turbo target. */
  bodyAttributesHtml?: string;
  open?: boolean;
}

/** Native disclosure composed with either Content row presentation and one shared gutter. */
export function disclosureHtml(options: DisclosureOptions): string {
  const id = options.element?.id === undefined ? "" : ` id="${escapeHtml(options.element.id)}"`;
  const content: ContentRowContent = { ...options.summary, leadingHtml: `${Icons.Disclosure}${options.summary.leadingHtml ?? ""}` };
  const summary = `<summary class="${contentRowClasses(content, true, true)}"${attributesHtml(options.summary.attributesHtml)}>${contentRowContentHtml(content)}</summary>`;
  return `<details${id} class="disclosure"${options.open ? " open" : ""}${attributesHtml(options.element?.attributesHtml)}>${summary}<div class="disclosure-content"${attributesHtml(options.bodyAttributesHtml)}>${options.bodyHtml}</div></details>`;
}
