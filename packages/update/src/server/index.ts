import { createInstallationClient, type InstallationClient } from "./installation.ts";
import type { InstallationUpdate } from "@kintsugi/shared/installation-update";
import { warningBannerHtml } from "@kintsugi/design-system/warning-banner";
import { Type } from "typebox";
import { buttonHtml } from "@kintsugi/design-system/button";
import { destructiveConfirmationHtml } from "@kintsugi/design-system/destructive-confirmation";
import { Icons } from "@kintsugi/design-system/icons";
import { progressButtonHtml } from "@kintsugi/design-system/progress-button";
import { toggleHtml } from "@kintsugi/design-system/toggle";
import { transientFeedbackHtml } from "@kintsugi/design-system/transient-feedback";
import { errorMessage, escapeHtml, turboStream, turboStreamResponse, type SettingsContribution, type WorkspaceModule, type WorkspaceServerModuleContext } from "@kintsugi/shared";
import { isUpdateChannel, type UpdateChannel } from "./update-channel.ts";
import { detectSelfUpdateRuntime, prepareUpdate, type PreparedUpdate, type PullProgress, type SelfUpdateRuntime } from "./docker.ts";
import { fetchChannelImageMetadata, type ImageMetadata } from "./registry.ts";
import { readStoredUpdateChannel, writeStoredUpdateChannel, readStoredReleaseSource, writeStoredReleaseSource, readStoredTrackingChannel } from "./settings-store.ts";
import { defaultReleaseSource, releaseReference, trackingReleaseSource, releaseSourceSchema, registryCredentialSchema, type ReleaseSource } from "@kintsugi/shared/release-source";
import { Value } from "typebox/value";
import { requestSupervisorUpdate, checkSupervisorRelease, prepareSupervisorRelease, supervisorRegistryRequest, requestSupervisorRollback } from "./supervisor.ts";

const updateSidebarContributionId = "kintsugi-update";
const pollIntervalMs = 5 * 60 * 1000;

type UpdateState = "idle" | "checking" | "available" | "pulling" | "ready_to_restart" | "failed" | "restarting";

interface StateSnapshot {
  state: UpdateState;
  percent?: number;
  error?: string;
  selfUpdatable: boolean;
  target?: ImageMetadata;
  updateChannel: UpdateChannel;
  releaseSource: ReleaseSource;
  progressMessage?: string;
  updateScope: "installation" | "app";
  appReference: string;
  systemReference: string;
}

export interface UpdateManagerDeps {
  installationClient?: InstallationClient;
  readTrackingChannel?: () => Promise<"stable" | "latest">;
  readSource?: () => Promise<ReleaseSource | undefined>;
  writeSource?: (source: ReleaseSource) => Promise<void>;
  readChannel?: () => Promise<UpdateChannel | undefined>;
  writeChannel?: (channel: UpdateChannel) => Promise<void>;
  detectRuntime?: () => Promise<SelfUpdateRuntime | undefined>;
  fetchMetadata?: (channel: UpdateChannel) => Promise<ImageMetadata>;
  prepareUpdate?: (reference: string, onProgress: (progress: PullProgress) => void) => Promise<PreparedUpdate>;
  requestUpdate?: (imageId: string) => Promise<void>;
  setInterval?: (handler: () => void, interval: number) => void;
}

class UpdateConflictError extends Error {}

/** Coordinates Updates for the System-managed installation, not Workspace packages or agent CLIs. */
export class UpdateManager {
  private context: WorkspaceServerModuleContext | undefined;
  private installationClient: InstallationClient | undefined;
  private lastInstallationCheck = 0;
  private installationUnavailable = false;
  private installationPlanId: string | undefined;
  private runtime: SelfUpdateRuntime | undefined;
  private state: UpdateState = "idle";
  private percent: number | undefined;
  private error: string | undefined;
  private target: ImageMetadata | undefined;
  private releaseSource: ReleaseSource = { ...defaultReleaseSource };
  private trackingChannel: "stable" | "latest" = "latest";
  private updateChannel: UpdateChannel = "latest";
  private pullPromise: Promise<void> | undefined;
  private prepared: PreparedUpdate | undefined;
  private progressMessage: string | undefined;
  private restarting = false;
  private switchingChannel = false;
  private configurationError: string | undefined;
  private channelGeneration = 0;

  constructor(private readonly deps: UpdateManagerDeps = {}) {}

  async initialize(context: WorkspaceServerModuleContext): Promise<void> {
    this.context = context;
    this.runtime = await (this.deps.detectRuntime ?? detectSelfUpdateRuntime)();
    try {
      if (this.runtime && this.deps.installationClient) {
        this.installationClient = this.deps.installationClient;
        if (!await this.installationClient.installed()) this.installationClient = undefined;
      }
      this.trackingChannel = await this.deps.readTrackingChannel?.() ?? "latest";
      this.releaseSource = await this.deps.readSource?.() ?? { ...defaultReleaseSource };
      this.updateChannel = await this.deps.readChannel?.() ?? (this.deps.readSource ? "custom" : "latest");
    } catch (error) {
      this.configurationError = errorMessage(error);
      this.setState("failed", { error: this.configurationError });
    }
    this.updateSidebar();
    if (!this.runtime) return;
    if (this.installationClient && !this.configurationError) {
      try { this.acceptInstallation(await this.installationClient.status()); }
      catch (error) { this.installationUnavailable = true; this.setState("failed", { error: errorMessage(error) }); }
    }
    if (this.state !== "failed") await this.checkNow().catch((error) => console.error("Update check failed", error));
    const checkForUpdate = () => {
      if (this.installationClient) {
        if (this.state === "restarting" || this.state === "pulling" || this.installationUnavailable) {
          void this.installationClient.status().then(status=>this.acceptInstallation(status)).catch(error=>{ this.installationUnavailable = true; this.setState("failed",{error:errorMessage(error)}); }); return;
        }
        if(this.state === "failed" || Date.now()-this.lastInstallationCheck < pollIntervalMs) return;
      }
      void this.checkNow().catch((error) => console.error("Update check failed", error));
    };
    const intervalMs = this.installationClient ? 2000 : pollIntervalMs;
    if (this.deps.setInterval) {
      this.deps.setInterval(checkForUpdate, intervalMs);
    } else {
      const interval = setInterval(checkForUpdate, intervalMs);
      interval.unref?.();
    }
  }

  snapshot(): StateSnapshot {
    const settings = { releaseSource: this.releaseSource, releaseChannel: this.updateChannel === "custom" ? this.trackingChannel : this.updateChannel, releaseMode: "custom" as const };
    return { updateScope: this.installationClient ? "installation" : "app", appReference: releaseReference(settings, "app"), systemReference: releaseReference(settings, "system"), state: this.state, percent: this.percent, error: this.error, selfUpdatable: Boolean(this.runtime), target: this.target, updateChannel: this.updateChannel, releaseSource: { ...this.releaseSource }, progressMessage: this.progressMessage };
  }

  private updateSidebar(checked = false): void {
    const sidebarHtml = renderSidebarRow(this.snapshot());
    this.context?.globalSidebarContributions.set(updateSidebarContributionId, sidebarHtml || undefined, [
      { target: "settings-sec-update", html: renderUpdateSettings(this, checked), action: "replace" },
      { target: "settings-sec-update-channel", html: renderUpdateChannelSettings(this), action: "replace" },
      { target: "settings-sec-release-source", html: renderReleaseSourceSettings(this), action: "replace" },
    ]);
  }

  private setState(state: UpdateState, options: { percent?: number; error?: string } = {}, checked = false): void {
    this.state = state;
    this.percent = options.percent;
    this.error = options.error;
    this.updateSidebar(checked);
  }

  async checkNow(options: { announceCurrent?: boolean } = {}): Promise<void> {
    if (this.configurationError || !this.runtime || this.switchingChannel || this.pullPromise || this.prepared || (this.restarting && !this.installationClient)) return;
    if (this.installationClient) {
      this.lastInstallationCheck = Date.now();
      const generation = this.channelGeneration;
      try {
        const status = await this.installationClient.check();
        if (generation === this.channelGeneration) this.acceptInstallation(status);
      }
      catch(error) {
        if (generation !== this.channelGeneration) return;
        this.setState("failed", { error: errorMessage(error) }); throw error;
      }
      return;
    }
    const generation = this.channelGeneration;
    const channel = this.updateChannel;
    if (this.state === "idle" || this.state === "failed") this.setState("checking");
    let target: ImageMetadata;
    try {
      target = await (this.deps.fetchMetadata ?? fetchChannelImageMetadata)(channel);
    } catch (error) {
      // A superseded channel's failures are as stale as its successful responses.
      if (generation !== this.channelGeneration || this.pullPromise || this.prepared || this.restarting) return;
      this.setState("failed", { error: errorMessage(error) });
      throw error;
    }
    if (generation !== this.channelGeneration || this.pullPromise || this.prepared || this.restarting) return;
    this.target = target;
    const current = target.revision ? this.runtime.currentRevision ?? this.runtime.currentDigest : this.runtime.currentDigest;
    const remote = target.revision ?? target.digest;
    const available = Boolean(remote && current && remote !== current && this.runtime.currentDigest !== target.digest && this.runtime.currentDigest !== target.indexDigest);
    if (!available) this.setState("idle", {}, options.announceCurrent ?? false);
    else this.setState("available");
  }

  private acceptInstallation(status: InstallationUpdate): void {
    this.installationUnavailable = false;
    this.installationPlanId = status.plan?.id;
    this.target = status.plan ? { digest: status.plan.app.split("@")[1]! } : undefined;
    this.restarting = status.phase === "updating";
    const states = { idle: "idle", available: "available", preparing: "pulling", ready: "ready_to_restart", updating: "restarting", succeeded: "idle", failed: "failed", "rolled-back": "failed" } as const;
    this.progressMessage = status.message;
    this.setState(states[status.phase], status.phase === "failed" || status.phase === "rolled-back" ? {error: status.message} : {});
  }

  async rollback():Promise<void> {
    if(this.installationClient) this.acceptInstallation(await this.installationClient.rollback());
    else await requestSupervisorRollback();
  }

  async setUpdateChannel(channel: UpdateChannel): Promise<void> {
    if (!this.runtime) throw new Error("Kintsugi is not running in a System-managed installation");
    if (this.switchingChannel || this.pullPromise || this.restarting) throw new Error("Cannot switch update channels while an update is in progress");
    if (channel === this.updateChannel) return await this.checkNow();
    this.switchingChannel = true;
    try {
      await this.deps.writeChannel?.(channel);
      this.channelGeneration += 1;
      this.updateChannel = channel;
      if (channel !== "custom") { this.trackingChannel = channel; this.releaseSource = { ...this.releaseSource, appVersion: channel, systemVersion: channel }; }
      else if (this.deps.readSource) this.releaseSource = await this.deps.readSource() ?? { ...defaultReleaseSource };
      this.target = undefined;
      this.prepared = undefined;
      this.setState("idle");
    } finally {
      this.switchingChannel = false;
    }
    await this.checkNow();
  }

  startPull(): Promise<void> {
    if (!this.runtime) throw new UpdateConflictError("Kintsugi is not running in a System-managed installation");
    if (this.switchingChannel) throw new UpdateConflictError("Update channel change is in progress");
    if (this.pullPromise) return this.pullPromise;
    if (!this.target || (this.state !== "available" && this.state !== "failed")) {
      throw new UpdateConflictError("No update is available to download. Check the selected channel first.");
    }
    this.pullPromise = this.pullNewestTarget().catch((error) => {
      this.setState("failed", { error: errorMessage(error) });
    }).finally(() => {
      this.pullPromise = undefined;
    });
    return this.pullPromise;
  }

  private async pullNewestTarget(): Promise<void> {
    if (this.installationClient) {
      const checked = await this.installationClient.check();
      this.acceptInstallation(checked);
      if (!checked.plan || checked.phase !== "available") throw new UpdateConflictError("No installation update is available");
      this.acceptInstallation(await this.installationClient.prepare(checked.plan.id));
      while(this.state === "pulling") { await Bun.sleep(1000); this.acceptInstallation(await this.installationClient.status()); }
      if(this.state !== "ready_to_restart") throw new Error(this.error ?? "Installation preparation failed");
      return;
    }
    const source = this.releaseSource;
    const reference = `${source.appRepository}@${this.target!.digest}`;
    this.prepared = undefined;
    this.setState("pulling");
    this.prepared = await (this.deps.prepareUpdate ?? prepareUpdate)(reference, (progress) => {
      this.percent = progress.percent;
      this.progressMessage = progress.message;
      this.updateSidebar();
    });
    this.progressMessage = undefined;
    this.setState("ready_to_restart", { percent: 100 });
  }

  async restart(): Promise<void> {
    if (!this.runtime) throw new UpdateConflictError("Kintsugi is not running in a System-managed installation");
    if (this.switchingChannel || this.restarting) throw new UpdateConflictError("An update is already in progress");
    if (this.installationClient && this.state === "ready_to_restart" && this.installationPlanId) {
      this.acceptInstallation(await this.installationClient.apply(this.installationPlanId));
      return;
    }
    if (this.state !== "ready_to_restart" || !this.prepared) throw new UpdateConflictError("No prepared update is ready to restart");
    this.restarting = true;
    this.setState("restarting");
    try {
      await (this.deps.requestUpdate ?? requestSupervisorUpdate)(this.prepared.imageId);
    } catch (error) {
      this.restarting = false;
      this.setState("ready_to_restart", { error: errorMessage(error) });
      throw error;
    }
  }

  async setReleaseSource(source: ReleaseSource): Promise<void> {
    if (!Value.Check(releaseSourceSchema, source)) throw new Error("Invalid release source");
    if (!this.runtime || this.switchingChannel || this.pullPromise || this.restarting) throw new UpdateConflictError("Cannot change release source during an update or outside System");
    this.switchingChannel = true;
    try {
      const selected = trackingReleaseSource(source);
      await this.deps.writeSource?.(selected);
      this.releaseSource = selected;
      this.updateChannel = "custom";
      this.configurationError = undefined;
      this.channelGeneration++;
      this.target = undefined;
      this.prepared = undefined;
      this.setState("idle");
    } finally { this.switchingChannel = false; }
    try { await this.checkNow(); }
    catch (error) { console.error("Release source saved; discovery failed", error); }
  }

  clearError(): void {
    this.error = undefined;
    this.updateSidebar();
  }
}

const manager = new UpdateManager({
  installationClient: createInstallationClient(),
  readChannel: readStoredUpdateChannel, writeChannel: writeStoredUpdateChannel,
  readSource: readStoredReleaseSource, writeSource: writeStoredReleaseSource, readTrackingChannel: readStoredTrackingChannel,
  fetchMetadata: () => checkSupervisorRelease(),
  prepareUpdate: (reference) => prepareSupervisorRelease(reference),
});

function renderReleaseSourceSettings(updateManager: UpdateManager, message = ""): string {
  const snapshot = updateManager.snapshot();
  const source = snapshot.releaseSource;
  if (snapshot.updateChannel !== "custom") return '<section id="settings-sec-release-source" hidden></section>';
  if (!snapshot.selfUpdatable) return '<section class="settings-sec" id="settings-sec-release-source"><h2>Release source</h2><p class="settings-sub">Release sources and private registry access require a System-managed installation.</p></section>';
  const pinned = source.appVersion && !["latest", "stable"].includes(source.appVersion);
  const selection = `<p class="settings-sub">App selection: <code>${escapeHtml(snapshot.appReference)}</code><br>System selection: <code>${escapeHtml(snapshot.systemReference)}</code></p>${pinned ? warningBannerHtml({ message: "The app checks your selected tag or digest. Select Latest to follow new releases in these repositories." }) : ""}`;
  const fields = ([
    ["appRepository", "App repository"], ["systemRepository", "System repository"],
    ["appVersion", "App version or digest (optional)"], ["systemVersion", "System version or digest (optional)"],
  ] as const).map(([name, label]) => `<label>${label}<input class="text-field" name="${name}" value="${escapeHtml(source[name] ?? "")}" ${name.endsWith("Repository") ? "required" : ""}></label>`).join("");
  const save = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Use custom source" } });
  const credentials = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Save registry access" } });
  return `<section class="settings-sec release-source-settings" id="settings-sec-release-source"><h2>Custom source</h2><p class="settings-sub">Use a GHCR or Docker Hub repository. Latest follows new releases in these repositories. Leave versions blank to follow Latest in these repositories. A version tag or digest keeps that selection. Saving does not download or restart anything.</p><form method="post" action="/settings/release-source" data-turbo="true">${fields}${save}</form>${selection}<h3>Private GHCR access</h3><p class="settings-sub">Stored privately in System, never sent to workspaces. Use a token with package read access.</p><form method="post" action="/settings/release-registry" data-turbo="true" autocomplete="off"><label>GitHub username<input class="text-field" name="username" required></label><label>Package read token<input class="text-field" type="password" name="token" required autocomplete="new-password"></label>${credentials}</form>${message ? `<p role="status">${escapeHtml(message)}</p>` : ""}</section>`;
}

function renderCheckButton(state: "initial" | "in-progress"): string {
  return progressButtonHtml({
    initialContent: { kind: "text", text: "Check now" },
    progressContent: { kind: "text", text: "Checking…" },
    state,
    variant: "secondary",
    type: "submit",
  });
}

function renderCheckForm(): string {
  return `<form method="post" action="/update/check-now" data-turbo="true">${renderCheckButton("initial")}</form>`;
}

function renderDownloadControl(snapshot: StateSnapshot): string {
  const content = {
    initialContent: { kind: "text" as const, text: "Download update" },
    progressContent: { kind: "text" as const, text: "Downloading…" },
    variant: "primary" as const,
    type: "submit" as const,
  };
  if (snapshot.state === "pulling") return progressButtonHtml({ ...content, state: "in-progress", progress: snapshot.percent ?? 1 });
  const button = progressButtonHtml({ ...content, state: "initial" });
  return `<form method="post" action="/update/start" data-turbo="true">${button}</form>`;
}

type UpdateControlSurface = "settings" | "sidebar";

function restartFeedbackId(surface: UpdateControlSurface): string {
  return `update_restart_feedback_${surface}`;
}

function restartFormHtml(surface: UpdateControlSurface): string {
  const confirmation = destructiveConfirmationHtml({
    id: `restart_${surface}`,
    trigger: { type: "button", variant: "primary", content: { kind: "caption", caption: "Restart to update" } },
    confirmCaption: "Restart now",
    cancelCaption: "Cancel",
  });
  return `<form method="post" action="/update/restart?surface=${surface}" data-turbo="false" data-controller="update-restart" data-action="submit->update-restart#submit">${confirmation}<p role="alert" data-update-restart-target="error" hidden></p></form>`;
}

function renderRestartFeedback(surface: UpdateControlSurface, message?: string): string {
  return transientFeedbackHtml({
    element: { tag: "div",  attributesHtml: `id="${restartFeedbackId(surface)}"` },
    initialContent: { kind: "html", html: restartFormHtml(surface) },
    feedbackContent: { kind: "html", html: `<span class="transient-feedback__status update-restart-error">Could not restart: ${escapeHtml(message ?? "")}</span>` },
    state: message === undefined ? "initial" : "feedback",
  });
}

function renderCheckFeedback(state: "initial" | "in-progress", feedback = false): string {
  return transientFeedbackHtml({
    element: { tag: "div" },
    initialContent: { kind: "html", html: state === "initial" ? renderCheckForm() : renderCheckButton("in-progress") },
    feedbackContent: { kind: "html", html: '<span class="transient-feedback__status">The app matches the selected release.</span>' },
    state: feedback ? "feedback" : "initial",
  });
}

function renderUpdateControl(snapshot: StateSnapshot, surface: UpdateControlSurface): string {
  if (snapshot.state === "checking") return renderCheckFeedback("in-progress");
  if (!snapshot.selfUpdatable) return "";
  if ((snapshot.state === "failed" && !snapshot.target) || snapshot.state === "idle") return renderCheckFeedback("initial");
  if (snapshot.state === "available" || snapshot.state === "failed" || snapshot.state === "pulling") return renderDownloadControl(snapshot);
  if (snapshot.state === "ready_to_restart") return renderRestartFeedback(surface);
  return progressButtonHtml({
    initialContent: { kind: "text", text: "Restart to update" },
    progressContent: { kind: "text", text: "Restarting…" },
    state: "in-progress",
    variant: "primary",
  });
}

function updateDescription(snapshot: StateSnapshot): string {
  if (!snapshot.selfUpdatable) return "Updates require a System-managed installation.";
  if (snapshot.updateScope === "installation") return snapshot.progressMessage ?? "Check for installation updates.";
  switch (snapshot.state) {
    case "idle": return "Check for app updates.";
    case "checking": return "Checking for updates…";
    case "available": return "An app update is available.";
    case "pulling": return "Downloading the app update…";
    case "ready_to_restart": return "";
    case "restarting": return "";
    case "failed": return "The update needs attention.";
  }
}

function renderUpdateSettings(updateManager: UpdateManager, checked = false): string {
  const snapshot = updateManager.snapshot();
  const control = checked && snapshot.state === "idle" ? renderCheckFeedback("initial", true) : renderUpdateControl(snapshot, "settings");
  const description = updateDescription(snapshot);
  return `<section class="settings-sec update-settings-control" id="settings-sec-update"><div class="update-settings-summary"><h2>Updates</h2>${description ? `<p class="settings-sub">${description}</p>` : ""}</div><div class="update-actions">${control}</div>${renderError(snapshot)}${snapshot.selfUpdatable ? `<p class="settings-sub">${snapshot.updateScope === "installation" ? "Updates include System, the app and workspace image dependencies. Restart interrupts running workspaces; their saved data is retained." : "Host updater is not installed. Web updates currently replace only the app. Full updates require Linux/systemd; on compatible hosts, run the current installer once to enable them."}</p>` : ""}</section>`;
}

function renderUpdateChannelSettings(updateManager: UpdateManager): string {
  const snapshot = updateManager.snapshot();
  const disabled = !snapshot.selfUpdatable || snapshot.state === "pulling" || snapshot.state === "restarting";
  const channel = toggleHtml({
    variant: "button",
    label: "Update channel",
    name: "channel",
    value: snapshot.updateChannel,
    form: { action: "/settings/update-channel" },
    options: [
      { value: "stable", label: "Stable", disabled },
      { value: "latest", label: "Latest", disabled },
      { value: "custom", label: "Custom", disabled },
    ],
  });
  return `<section class="settings-sec settings-choice-row" id="settings-sec-update-channel"><h2>Update channel</h2>${channel}</section>`;
}

function updateSettingsStream(updateManager: UpdateManager, checked = false): string {
  return turboStream("replace", "settings-sec-update", renderUpdateSettings(updateManager, checked), { method: "morph" });
}

const updateSettingsContribution: SettingsContribution = {
  id: "update",
  label: "Updates",
  order: 15,
  render: async () => renderUpdateSettings(manager),
};

const updateChannelSettingsContribution: SettingsContribution = {
  id: "update-channel",
  label: "Update channel",
  order: 14,
  render: async () => renderUpdateChannelSettings(manager),
};

function renderSidebarRow(snapshot: StateSnapshot): string {
  if (!snapshot.selfUpdatable || snapshot.state === "idle" || snapshot.state === "checking") return "";
  const description = updateDescription(snapshot);
  return `<section class="update-sidebar-section"><div id="update_sidebar_row" class="update-sidebar-row">${description ? `<p>${description}</p>` : ""}<div class="update-actions">${renderUpdateControl(snapshot, "sidebar")}</div>${renderError(snapshot)}</div></section>`;
}

function renderError(snapshot: StateSnapshot): string {
  if (!snapshot.error) return "";
  const dismiss = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss update error" } });
  return `<div role="alert"><p>${escapeHtml(snapshot.error)}</p><form method="post" action="/update/dismiss-error" data-turbo="true">${dismiss}</form></div>`;
}

export function createUpdateRouteHandler(updateManager: UpdateManager): (request: Request, url: URL) => Promise<Response | undefined> {
  return async (request, url) => {
    const json = request.headers.get("accept")?.includes("application/json");
    const releasePath = url.pathname === "/settings/release-source" || url.pathname === "/settings/release-registry";
    if ((releasePath || url.pathname === "/update/status") && !updateManager.snapshot().selfUpdatable) return Response.json({ error: "Updates require Kintsugi System" }, { status: 409 });
    if (url.pathname === "/update/rollback" && request.method === "POST") {
      await updateManager.rollback();
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (url.pathname === "/update/status" && request.method === "GET") return Response.json(updateManager.snapshot());
    if (url.pathname === "/settings/release-source") {
      if (request.method === "GET") return Response.json(updateManager.snapshot().releaseSource);
      if (request.method === "POST") {
        let source: unknown;
        if (request.headers.get("content-type")?.includes("application/json")) source = await request.json();
        else {
          const form = await request.formData();
          source = Object.fromEntries(["appRepository", "systemRepository", "appVersion", "systemVersion"].flatMap(name => {
            const value = form.get(name); return value ? [[name, value]] : [];
          }));
        }
        if (!Value.Check(releaseSourceSchema, source)) return Response.json({ error: "Invalid Docker release source" }, { status: 400 });
        try { await updateManager.setReleaseSource(source); }
        catch (error) {
          if (error instanceof UpdateConflictError) return Response.json({ error: errorMessage(error) }, { status: 409 });
          throw error;
        }
        return json ? Response.json(updateManager.snapshot().releaseSource) : turboStreamResponse(turboStream("replace", "settings-sec-release-source", renderReleaseSourceSettings(updateManager, "Release source saved.")));
      }
    }
    if (url.pathname === "/settings/release-registry" && (request.method === "GET" || request.method === "POST" || request.method === "DELETE")) {
      let credentials: unknown;
      if (request.method === "POST") credentials = request.headers.get("content-type")?.includes("application/json") ? await request.json() : Object.fromEntries(await request.formData());
      if (request.method === "POST" && !Value.Check(registryCredentialSchema, credentials)) return Response.json({ error: "Invalid registry credentials" }, { status: 400 });
      const result = await supervisorRegistryRequest(request.method, request.method === "POST" ? Value.Parse(registryCredentialSchema, credentials) : undefined);
      return json || request.method === "GET" ? Response.json(result) : turboStreamResponse(turboStream("replace", "settings-sec-release-source", renderReleaseSourceSettings(updateManager, "Registry access saved.")));
    }
    if (request.method === "POST" && (url.pathname.startsWith("/update/") || url.pathname === "/settings/update-channel") && !updateManager.snapshot().selfUpdatable) return new Response("Updates require Kintsugi System", { status: 409 });
    if (url.pathname === "/update/dismiss-error" && request.method === "POST") {
      updateManager.clearError();
      return turboStreamResponse("");
    }
    if (url.pathname === "/settings/update-channel" && request.method === "POST") {
      const channelInput: unknown = request.headers.get("content-type")?.includes("application/json") ? await request.json() : Object.fromEntries(await request.formData());
      const channel = Value.Parse(Type.Object({ channel: Type.String() }), channelInput).channel;
      if (!isUpdateChannel(channel)) return new Response("Unsupported update channel", { status: 400 });
      await updateManager.setUpdateChannel(channel);
      return json ? Response.json(updateManager.snapshot()) : turboStreamResponse("");
    }
    if (url.pathname === "/update/start" && request.method === "POST") {
      try {
        void updateManager.startPull();
      } catch (error) {
        if (!(error instanceof UpdateConflictError)) throw error;
        return json ? Response.json({ error: errorMessage(error) }, { status: 409 }) : turboStreamResponse(updateSettingsStream(updateManager), { status: 409 });
      }
      return json ? Response.json(updateManager.snapshot(), { status: 202 }) : turboStreamResponse("");
    }
    if (url.pathname === "/update/check-now" && request.method === "POST") {
      await updateManager.checkNow({ announceCurrent: true });
      return json ? Response.json(updateManager.snapshot()) : turboStreamResponse("");
    }
    if (url.pathname === "/update/restart" && request.method === "POST") {
      try {
        await updateManager.restart();
        if (json) return Response.json({ accepted: true }, { status: 202 });
        return new Response(null, { status: 204, headers: { "x-kintsugi-reload": "true" } });
      } catch (error) {
        if (json) return Response.json({ error: errorMessage(error) }, { status: 409 });
        const surface = url.searchParams.get("surface");
        if (surface !== "settings" && surface !== "sidebar") return new Response("Missing update control surface", { status: 400 });
        const message = errorMessage(error);
        return turboStreamResponse(turboStream("replace", restartFeedbackId(surface), renderRestartFeedback(surface, message)));
      }
    }
    return undefined;
  };
}

export const kintsugiServerModule: WorkspaceModule = {
  id: "kintsugi-update",
  settingsContributions: [updateChannelSettingsContribution, { id: "release-source", label: "Release source", order: 16, render: async () => renderReleaseSourceSettings(manager) }, updateSettingsContribution],
  staticFiles: {
    "/update-client.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  async initialize(context) {
    await manager.initialize(context);
  },
  routes: [{ handle: createUpdateRouteHandler(manager) }],
};
