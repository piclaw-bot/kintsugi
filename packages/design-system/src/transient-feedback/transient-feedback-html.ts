import { escapeHtml } from "@kintsugi/shared";
import type { ButtonVariant } from "../button/button-html.ts";
import { attributesHtml, classNames, htmlContent, type HtmlContent } from "../html.ts";

export type TransientFeedbackContent = HtmlContent;

type TransientFeedbackElement = ({ tag: "button"; variant?: ButtonVariant } | { tag: "div" }) & {
  /** Caller-owned attributes. Do not supply feedback state or controller attributes here. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
}

export interface TransientFeedbackOptions {
  element: TransientFeedbackElement;
  initialContent: TransientFeedbackContent;
  feedbackContent: TransientFeedbackContent;
  state: "initial" | "feedback";
  /** Keeps button controls interactive while their feedback content is visible. */
  keepEnabledDuringFeedback?: boolean;
}

/**
 * Renders content which briefly acknowledges a completed action before restoring
 * its initial content. Only the active content participates in layout.
 */
export function transientFeedbackHtml(options: TransientFeedbackOptions): string {
  const className = classNames("transient-feedback", options.element.tag === "button" && "button", options.element.tag === "button" && (options.element.variant ?? "secondary"));
  const { element } = options;
  const contentTag = element.tag === "button" ? "span" : "div";
  const initialHidden = options.state === "feedback" ? " hidden" : "";
  const feedbackHidden = options.state === "initial" ? " hidden" : "";
  const keepEnabled = options.keepEnabledDuringFeedback ? " data-transient-feedback-keep-enabled" : "";
  const disabled = element.tag === "button" && options.state === "feedback" && !options.keepEnabledDuringFeedback ? " disabled" : "";

  return `<${element.tag} class="${escapeHtml(className)}" data-controller="transient-feedback" data-transient-feedback-state-value="${options.state}"${keepEnabled}${attributesHtml(element.attributesHtml)}${disabled}><${contentTag} class="transient-feedback__content" data-transient-feedback-content="initial"${initialHidden}>${htmlContent(options.initialContent)}</${contentTag}><${contentTag} class="transient-feedback__content" data-transient-feedback-content="feedback" role="status"${feedbackHidden}>${htmlContent(options.feedbackContent)}</${contentTag}></${element.tag}>`;
}
