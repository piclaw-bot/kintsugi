import { restoreAppSettingsDestination } from "./app-settings-controller.ts";
import { restoreTemplateSettingsDestination } from "./template-settings-controller.ts";
import { markActiveWorkspaceRow } from "./workspace-presentation.ts";
import { phoneLayoutMediaQuery } from "@kintsugi/shared";
import { Controller } from "@hotwired/stimulus";
import { liveSurfaceReady, prepareLiveSurface, releaseLiveSurface } from "./live-surface.ts";
import { controllerForElement, registerWorkspaceControllers, workspaceNavigationController } from "./workspace-controller-registry.ts";

export type WorkspaceSelectionEvent = CustomEvent<{ resume(): Promise<void> }>;

interface ResidentPresentation {
  prepareIntendedSurfaces(): Promise<void>;
  intendedSurfacesReady(): boolean;
}

class WorkspaceResidencyController extends Controller<HTMLElement> {
  static targets = ["resident", "empty", "loading"];
  static values = { maxResident: Number };
  declare readonly residentTargets: HTMLElement[];
  declare readonly emptyTargets: HTMLElement[];
  declare readonly loadingTargets: HTMLElement[];
  declare readonly maxResidentValue: number;
  private intended?: string;
  private selectedFromList = false;
  private selection = 0;
  private readonly preparing = new Set<HTMLElement>();
  private retained = new Set<HTMLElement>();

  connect(): void {
    document.addEventListener("kintsugi:workspace-pane-changed", this.changed);
    this.element.addEventListener("live:ready", this.changed);
    document.addEventListener("live:connection", this.changed);
    document.addEventListener("kintsugi:workspace-pane-visible", this.reportVisibility);
    document.addEventListener("kintsugi:workspace-pane-hidden", this.reportVisibility);
    document.addEventListener("visibilitychange", this.reportVisibility);
    document.addEventListener("kintsugi:mobile-workspace-pane-changed", this.reportVisibility);
    window.addEventListener("popstate", this.historyChanged);
    this.historyChanged();
  }
  disconnect(): void {
    this.selection++;
    document.removeEventListener("kintsugi:workspace-pane-changed", this.changed);
    this.element.removeEventListener("live:ready", this.changed);
    document.removeEventListener("live:connection", this.changed);
    document.removeEventListener("kintsugi:workspace-pane-visible", this.reportVisibility);
    document.removeEventListener("kintsugi:workspace-pane-hidden", this.reportVisibility);
    document.removeEventListener("visibilitychange", this.reportVisibility);
    document.removeEventListener("kintsugi:mobile-workspace-pane-changed", this.reportVisibility);
    window.removeEventListener("popstate", this.historyChanged);
    window.KintsugiCable?.reportVisibility({ surfaceKeys: [] });
  }
  residentTargetConnected(resident: HTMLElement): void {
    if (resident.dataset.workspaceId === this.intended && !resident.classList.contains("visible")) void this.selectWorkspace(this.intended!, location.href, "none");
  }
  residentTargetDisconnected(resident: HTMLElement): void {
    if (resident.dataset.workspaceId === this.intended) this.unselectWorkspace(this.intended!);
    this.reportVisibility();
  }
  async selectWorkspace(workspaceId: string, href: string, historyMode: "push" | "none" = "push"): Promise<void> {
    if (historyMode === "push" && !this.element.dispatchEvent(new CustomEvent("workspace-residency:before-select", { bubbles: true, cancelable: true, detail: { resume: () => this.selectWorkspace(workspaceId, href, historyMode) } }))) return;
    const selection = ++this.selection;
    this.selectedFromList = historyMode === "push" || (this.intended === workspaceId && this.selectedFromList);
    this.intended = workspaceId;
    if (historyMode === "push" && new URL(href, location.href).href !== location.href) history.pushState({}, "", href);
    workspaceNavigationController()?.setActiveWorkspace(workspaceId);
    const resident = this.residentTargets.find(item => item.dataset.workspaceId === workspaceId);
    // A command acknowledgement can precede the shell snapshot containing its mount.
    if (!resident) return;
    this.hideResidents();
    this.emptyTargets.forEach(element => { element.hidden = true; });
    this.loadingTargets.forEach(element => { element.hidden = true; });
    resident.classList.add("visible");
    resident.dataset.lastActivatedAt = String(Date.now());
    await prepareLiveSurface(resident);
    if (selection !== this.selection) return;
    const presentation = resident.querySelector<HTMLElement>("[data-controller~='workspace-presentation']");
    presentation?.dispatchEvent(new CustomEvent("kintsugi:workspace-residency-visible", { detail: { selectedFromList: this.selectedFromList } }));
    this.selectedFromList = false;
    if (presentation) {
      const controller = controllerForElement<{ prepareIntendedSurfaces(): Promise<void>; focusSelectedAgent(): void }>(presentation, "workspace-presentation");
      await controller?.prepareIntendedSurfaces();
      if (selection !== this.selection) return;
      controller?.focusSelectedAgent();
    }
    this.changed();
    this.reportVisibility();

  }
  unselectWorkspace(workspaceId: string): void {
    if (this.intended !== workspaceId) return;
    this.selection++;
    this.intended = undefined;
    workspaceNavigationController()?.setActiveWorkspace();
    history.replaceState({}, "", "/");
    this.hideResidents();
    this.emptyTargets.forEach(element => { element.hidden = false; });
    workspaceNavigationController()?.showWorkspacePane();
    this.changed();
    this.reportVisibility();
  }
  visibleWorkspaceId(): string | undefined { return this.residentTargets.find(item => item.classList.contains("visible"))?.dataset.workspaceId; }
  oldestAttentionWorkspaceId(): string | undefined {
    const workspaces = [...document.querySelectorAll<HTMLElement>("[data-workspace-entry-id][data-workspace-attention-at]")]
      .sort((a, b) => Number(a.dataset.workspaceAttentionAt) - Number(b.dataset.workspaceAttentionAt));
    return (workspaces.find(row => {
      const resident = this.residentTargets.find(item => item.dataset.workspaceId === row.dataset.workspaceEntryId);
      return resident && this.prepared(resident);
    }) ?? workspaces[0])?.dataset.workspaceEntryId;
  }
  private hideResidents(): void {
    for (const resident of this.residentTargets) {
      if (resident.classList.contains("visible")) resident.querySelector("[data-controller~='workspace-presentation']")?.dispatchEvent(new Event("kintsugi:workspace-residency-hidden"));
      resident.classList.remove("visible");
    }
  }
  private presentation(resident: HTMLElement): ResidentPresentation | undefined {
    const element = resident.querySelector<HTMLElement>("[data-controller~='workspace-presentation']");
    return element ? controllerForElement<ResidentPresentation>(element, "workspace-presentation") ?? undefined : undefined;
  }
  private prepared(resident: HTMLElement): boolean {
    return liveSurfaceReady(resident) && (this.presentation(resident)?.intendedSurfacesReady() ?? false);
  }
  private maintainResidents(): void {
    const attention = new Map([...document.querySelectorAll<HTMLElement>("[data-workspace-entry-id][data-workspace-attention-at]")]
      .map(row => [row.dataset.workspaceEntryId!, Number(row.dataset.workspaceAttentionAt)]));
    const candidates = this.residentTargets.filter(resident => resident.classList.contains("visible") || resident.childElementCount || attention.has(resident.dataset.workspaceId!));
    candidates.sort((a, b) => Number(b.classList.contains("visible")) - Number(a.classList.contains("visible"))
      || (attention.get(a.dataset.workspaceId!) ?? Infinity) - (attention.get(b.dataset.workspaceId!) ?? Infinity)
      || Number(b.dataset.lastActivatedAt ?? 0) - Number(a.dataset.lastActivatedAt ?? 0));
    this.retained = new Set(candidates.slice(0, this.maxResidentValue));
    // The visible workspace goes live first; preloads would compete with it.
    const visible = this.residentTargets.find(resident => resident.classList.contains("visible"));
    const visibleLoading = visible !== undefined && !(liveSurfaceReady(visible) && (this.presentation(visible)?.intendedSurfacesReady() ?? true));
    for (const resident of candidates) {
      if (!this.retained.has(resident)) { releaseLiveSurface(resident); continue; }
      if (this.prepared(resident) || this.preparing.has(resident) || (visibleLoading && resident !== visible)) continue;
      this.preparing.add(resident);
      void (async () => {
        await prepareLiveSurface(resident);
        if (!resident.isConnected || !this.retained.has(resident)) return;
        await this.presentation(resident)?.prepareIntendedSurfaces();
      })().finally(() => { this.preparing.delete(resident); this.updateRows(); });
    }
  }
  private readonly changed = (): void => {
    const selected = this.residentTargets.find(resident => resident.dataset.workspaceId === this.intended);
    // Approval ends selection; container teardown can continue in the background.
    if (this.intended && selected?.querySelector('[data-deletion-status="deleting"]')) {
      this.unselectWorkspace(this.intended);
      return;
    }
    this.maintainResidents();
    this.updateRows();
  };
  private updateRows(): void {
    const active = this.visibleWorkspaceId();
    markActiveWorkspaceRow(document, active);
    document.querySelectorAll<HTMLElement>("[data-workspace-entry-id]").forEach(row => {
      const resident = this.residentTargets.find(item => item.dataset.workspaceId === row.dataset.workspaceEntryId);
      row.dataset.workspacePreloadState = resident && this.prepared(resident) ? "preloaded" : "unloaded";
    });
    const next = document.querySelector<HTMLButtonElement>("#fixed_shell_kintsugi_next_attention");
    if (next) {
      next.disabled = this.oldestAttentionWorkspaceId() === undefined;
      next.toggleAttribute("data-preloaded-attention", document.querySelector('[data-workspace-entry-id][data-workspace-attention-at][data-workspace-preload-state="preloaded"]') !== null);
    }
    const close = document.querySelector<HTMLButtonElement>("[data-close-workspace-pane]");
    if (close) close.disabled = active === undefined;
  }
  private readonly reportVisibility = (): void => {
    const workspaceId = this.visibleWorkspaceId();
    const hidden = document.hidden || this.element.inert || (window.matchMedia(phoneLayoutMediaQuery).matches && this.element.closest(".is-mobile-workspace-pane-open") !== null);
    const resident = this.residentTargets.find(item => item.dataset.workspaceId === workspaceId);
    const surfaceKeys = !hidden && resident ? [...resident.querySelectorAll<HTMLElement>('[data-workspace-surface-visible="true"]')].map(pane => `${pane.dataset.workspacePaneRole === "agent" ? "agent:" : ""}${pane.dataset.workspacePaneId}`) : [];
    window.KintsugiCable?.reportVisibility({ workspaceId: hidden ? undefined : workspaceId, surfaceKeys });
  };
  private readonly historyChanged = (): void => {
    if (restoreTemplateSettingsDestination() || restoreAppSettingsDestination()) return;
    const id = location.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1];
    if (id) void this.selectWorkspace(decodeURIComponent(id), location.href, "none");
    else if (this.intended) this.unselectWorkspace(this.intended);
  };
}
export function registerWorkspaceResidencyController(): void { registerWorkspaceControllers({ "workspace-residency": WorkspaceResidencyController }); }
