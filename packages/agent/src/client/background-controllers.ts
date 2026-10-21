import { slidePageChange } from "@kintsugi/design-system/page-slide/client";
import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@kintsugi/shared";

/** Slides the pane to a drill-in activity's page, and back to the conversation. */
export function createAgentBackgroundController(Controller: StimulusControllerConstructor) {
  return class AgentBackgroundController extends Controller {
    static targets = ["page", "frame"];
    static values = { path: String };
    declare readonly pathValue: string;
    declare readonly element: HTMLElement;
    declare readonly pageTarget: HTMLElement;
    declare readonly frameTarget: HTMLElement & { src: string | null };

    private openedFromUrl?: string;
    /** The pages opened from one another, such as a workflow's then one of its agents', so Back returns through them. */
    private trail: string[] = [];
    /** A link to this pane with `background=<key>`, such as one revealing a subagent's message, opens that activity's page, once. */
    connect(): void {
      const params = new URL(location.href).searchParams;
      const key = params.get("background");
      if (!key || params.get("agent") !== this.element.dataset.agentPaneAgentIdValue || location.href === this.openedFromUrl) return;
      this.openedFromUrl = location.href;
      this.show(`${this.pathValue}${encodeURIComponent(key)}`);
    }

    open(event: Event): void {
      if (!(event.currentTarget instanceof HTMLAnchorElement)) throw new Error("A background activity opens from a link");
      event.preventDefault();
      const href = event.currentTarget.href;
      // A page opened from another page returns to it; one opened from the list returns to the conversation.
      const from = this.pageTarget.hidden ? undefined : this.frameTarget.src;
      this.trail = from ? [...this.trail, from] : [];
      void slidePageChange(() => this.element, () => this.show(href), "forward");
    }

    private show(href: string): HTMLElement {
      this.frameTarget.src = href;
      this.pageTarget.hidden = false;
      this.element.classList.add("agent-pane--background-page");
      return this.element;
    }

    back(): void {
      const previous = this.trail.pop();
      if (previous) void slidePageChange(() => this.element, () => this.show(previous), "back");
      else this.close();
    }

    private close(): void {
      this.trail = [];
      void slidePageChange(() => this.element, () => {
        this.element.classList.remove("agent-pane--background-page");
        this.pageTarget.hidden = true;
        this.frameTarget.removeAttribute("src");
        this.frameTarget.replaceChildren();
        return this.element;
      }, "back");
    }

    /** A link into the conversation, such as "Started by", returns to it first, whichever pages led here; one into the page's own transcript, or to another activity's page, doesn't. */
    pageClicked(event: Event): void {
      const link = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action~="agent-pane#reveal"]') : null;
      if (link?.dataset.agentPaneAgentParam === this.element.dataset.agentPaneAgentIdValue) this.close();
    }
  };
}

/** Reloads the frame of a running activity while it is shown, so its output or transcript stays current. */
export function createAgentBackgroundRefreshController(Controller: StimulusControllerConstructor) {
  return class AgentBackgroundRefreshController extends Controller {
    declare readonly element: HTMLElement;
    private timer?: ReturnType<typeof setInterval>;

    connect(): void {
      const frame = this.element.closest<HTMLElement & { reload(): Promise<void> }>("turbo-frame");
      if (!frame) throw new Error("A background activity's detail refreshes inside its frame");
      this.timer = setInterval(() => {
        if (document.visibilityState === "visible" && frame.checkVisibility()) void frame.reload();
      }, 2000);
    }

    disconnect(): void {
      clearInterval(this.timer);
    }
  };
}
