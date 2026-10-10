import { finishOnboarding, onboardingCompleted } from "./state.ts";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { buttonHtml } from "@kintsugi/design-system/button";
import { dialogHtml } from "@kintsugi/design-system/dialog";
import { kintsugiBrandIconHtml } from "@kintsugi/design-system/icons";
import { turboStreamResponse } from "@kintsugi/shared";
import { hasGitHubToken } from "@kintsugi/proxy-egress";
import { hasAvailableEnabledModel, renderModelsDialog } from "@kintsugi/llm/server";
import { renderGitHubConnectButton, renderGitHubConnection } from "../settings/github.ts";
import { update } from "@kintsugi/shared/http";

export async function renderOnboardingDialog(options: { includeCompleted?: boolean; resumeAfter?: "github" } = {}): Promise<string> {
  if (!options.includeCompleted && !options.resumeAfter && await onboardingCompleted()) return "";
  const githubConnected = hasGitHubToken();
  const modelsReady = await hasAvailableEnabledModel();
  if (options.resumeAfter) return renderModelsDialog({ host: "onboarding" });
  if (!options.includeCompleted && githubConnected) return modelsReady ? "" : renderModelsDialog({ host: "onboarding" });

  const needsModelsStep = options.includeCompleted || !modelsReady;
  const caption = githubConnected ? "Continue" : "Continue without GitHub";
  const continueAction = needsModelsStep
    ? actionLinkHtml({ href: "/models?host=onboarding", variant: "secondary", content: { kind: "caption", caption }, attributesHtml: 'data-turbo-stream="true"' })
    : `<form method="post" action="/onboarding/finish" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption } })}</form>`;
  return dialogHtml({
    element: { id: "onboarding_dialog", attributesHtml: "data-dialog-auto-show" },
    iconHtml: kintsugiBrandIconHtml,
    titleCaption: "Set up Kintsugi",
    bodyHtml: `<div class="onboarding-progress" aria-label="Onboarding progress"><span class="onboarding-progress-item" aria-current="step"></span>${needsModelsStep ? '<span class="onboarding-progress-item"></span>' : ""}</div>
      <div class="onboarding-body form-stack"><h2 class="title">Connect GitHub</h2>${renderGitHubConnection("onboarding")}</div>`,
    bodyLayout: "full-bleed",
    footerHtml: `${continueAction}${githubConnected ? "" : renderGitHubConnectButton("onboarding")}`,
    omitCancelButton: true,
  });
}

export async function handleOnboardingRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/onboarding/finish" && request.method === "POST") return finishOnboarding();
  if (url.pathname === "/onboarding" && request.method === "GET") {
    const html = await renderOnboardingDialog({ includeCompleted: true });
    const acceptsStream = request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
    if (acceptsStream) return turboStreamResponse(update("onboarding_modal_host", html));
    // Onboarding is a modal flow, not a standalone page.
    return Response.redirect(new URL("/", url).toString(), 303);
  }
  return undefined;
}
