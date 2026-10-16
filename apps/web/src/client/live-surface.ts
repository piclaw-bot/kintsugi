import { CableTopics, type CableSubscription } from "@kintsugi/shared";
import { Controller } from "@hotwired/stimulus";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

const mounts = new WeakMap<HTMLElement, LiveSurfaceController>();

class LiveSurfaceController extends Controller<HTMLElement> {
  static values = { workspace: String, kind: String, key: String, eager: Boolean, agent: String, work: String };
  declare readonly workspaceValue: string;
  declare readonly kindValue: string;
  declare readonly keyValue: string;
  declare readonly eagerValue: boolean;
  declare agentValue: string;
  declare workValue: string;
  private subscription?: CableSubscription;
  private pending?: ReturnType<typeof Promise.withResolvers<void>>;
  ready = false;
  private failure?: HTMLElement;
  private failed = false;

  connect(): void {
    mounts.set(this.element, this);
    if (this.eagerValue) void this.ensureReady();
  }

  disconnect(): void {
    mounts.delete(this.element);
    this.stop();
  }

  release(): void {
    this.stop();
    this.element.replaceChildren();
  }

  private stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.ready = false;
    this.failed = false;
    this.pending?.resolve();
    this.pending = undefined;
  }

  select(agent: string, work: string): void {
    if (this.kindValue !== "workspace" || (this.agentValue === agent && this.workValue === work)) return;
    this.agentValue = agent;
    this.workValue = work;
    if (!this.subscription) return;
    this.stop();
    void this.ensureReady();
  }

  retry(): void {
    this.stop();
    void this.ensureReady();
  }

  private showFailure(reason: string): void {
    this.failure?.remove();
    const notice = document.createElement("div");
    notice.className = "settings-error";
    notice.setAttribute("role", "alert");
    const message = document.createElement("p");
    message.textContent = "This pane could not be loaded: " + reason;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button secondary";
    retry.textContent = "Retry pane";
    retry.dataset.action = "live-surface#retry";
    notice.append(message, retry);
    this.element.prepend(notice);
    this.failure = notice;
  }

  ensureReady(): Promise<void> {
    if (this.ready || this.failed) return Promise.resolve();
    if (this.pending) return this.pending.promise;
    const pending = this.pending = Promise.withResolvers<void>();
    if (this.subscription) return pending.promise;
    const identifier = this.kindValue === "workspace"
      ? CableTopics.module("surface", this.workspaceValue, { kind: this.kindValue, key: this.keyValue, agent: this.agentValue, work: this.workValue })
      : CableTopics.module("surface", this.workspaceValue, { kind: this.kindValue, key: this.keyValue });
    this.subscription = window.KintsugiCable!.subscribe(identifier, {
      onReady: () => {
        this.failure?.remove();
        this.failure = undefined;
        this.ready = true;
        this.pending?.resolve();
        this.pending = undefined;
        this.element.dispatchEvent(new CustomEvent("live:ready", { bubbles: true }));
      },
      onDisconnected: () => { this.ready = false; },
      onRejected: reason => {
        const pending = this.pending;
        const subscription = this.subscription;
        this.pending = undefined;
        this.subscription = undefined;
        this.ready = false;
        this.failed = true;
        this.showFailure(reason);
        // A rejected pane must not reject workspace selection or sibling preparation.
        pending?.resolve();
        subscription?.unsubscribe();
      },
    });
    return pending.promise;
  }
}

export async function prepareLiveSurface(element: HTMLElement): Promise<void> {
  // Newly inserted server HTML connects at Stimulus's next mutation checkpoint.
  if (!mounts.has(element)) await new Promise<void>(resolve => setTimeout(resolve, 0));
  const mount = mounts.get(element);
  if (!mount) throw new Error(`Live surface did not connect: ${element.id}`);
  await mount.ensureReady();
}

export function liveSurfaceReady(element: HTMLElement): boolean { return mounts.get(element)?.ready ?? false; }
export function registerLiveSurfaces(): void { registerWorkspaceControllers({ "live-surface": LiveSurfaceController }); }

export function releaseLiveSurface(element: HTMLElement): void { mounts.get(element)?.release(); }

export function selectLiveSurface(element: HTMLElement, agent: string, work: string): void {
  mounts.get(element)?.select(agent, work);
}
