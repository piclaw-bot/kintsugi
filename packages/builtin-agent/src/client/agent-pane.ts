import { setActivityButtonState } from "@kintsugi/design-system/activity-button/client";
import { CableTopics, changeLayout, isWorkspacePaneVisible, type AgentComposerSendPromptDetail, composerSubmitKey, setTextInputValue, type CableSubscription, type WorkspaceClientApplication as StimulusApplication, type WorkspaceClientControllerConstructor as StimulusControllerConstructor, type WorkspaceClientHooks } from "@kintsugi/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { agentComposerPrimaryAction, agentComposerTextStorageKey, PromptHistoryNavigator } from "@kintsugi/agent/client/composer-state";
import { TranscriptNavigation } from "@kintsugi/agent/client/transcript-navigation";

const steerResponseSchema = Type.Object({ input: Type.Object({ steered: Type.Boolean() }) });
const admissionSchema = Type.Object({ payload: Type.String(), requestId: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" }) });

type TurboSubmitEndEvent = CustomEvent<{ success: boolean; fetchResponse?: { response: Response } }>;

declare global {
  interface Window { KintsugiCable?: import("@kintsugi/shared").KintsugiCableClient; }
}

interface AgentPaneControllerInstance {
  becomeVisible(): void;
  noLongerVisible(): void;
  terminalConnected(terminal: AgentTermControllerInstance): void;
}

interface AgentTermControllerInstance { start(): void; stop(): void; }

function agentTermController(application: StimulusApplication, terminal: HTMLElement): AgentTermControllerInstance | null {
  // SAFETY: AgentTermController is registered under "agent-term" by builtinAgentClientModule.
  return application.getControllerForElementAndIdentifier(terminal, "agent-term") as AgentTermControllerInstance | null;
}

export function agentConnectionShouldRun(logicallyVisible: boolean, documentVisibility: DocumentVisibilityState): boolean {
  return logicallyVisible && documentVisibility === "visible";
}

export function createAgentPaneController(Controller: StimulusControllerConstructor) {
  return class AgentPaneController extends Controller implements AgentPaneControllerInstance {
    static values = { workspaceId: String, agentId: String, moduleChannel: String };
    static targets = ["transcript", "transcriptContent", "transcriptEnd", "input", "form", "sendStop", "queuedSteer"];
    declare readonly element: HTMLElement;
    declare readonly application: StimulusApplication;
    declare readonly workspaceIdValue: string;
    declare readonly agentIdValue: string;
    declare readonly moduleChannelValue: string;
    declare readonly transcriptTarget: HTMLElement;
    declare readonly transcriptContentTarget: HTMLElement;
    declare readonly transcriptEndTarget: HTMLElement;
    declare readonly inputTarget: HTMLTextAreaElement;
    declare readonly formTarget: HTMLFormElement;
    declare readonly sendStopTarget: HTMLButtonElement;
    declare readonly hasSendStopTarget: boolean;

    private navigation!: TranscriptNavigation;
    private logicallyVisible = false;
    private cableSubscription?: CableSubscription;
    private hasBeenReady = false;
    private composerMutationObserver?: MutationObserver;
    private connected = false;
    private submittedComposer?: { text: string; attachmentIds: string[]; requestId: string; busy: boolean };
    private steerWhenAdmitted = false;
    private sentSubmissionId?: string;
    private readonly identifySubmission = (event: FormDataEvent): void => {
      const body = event.formData;
      // Mode may change from send to steer while an uncertain request retries.
      const payload = JSON.stringify([...body.entries()].filter(([key]) => key !== "requestId" && key !== "mode"));
      const key = `${this.composerTextStorageKey}:admission`;
      const prior = this.pendingAdmission();
      const requestId = prior?.payload === payload ? prior.requestId : crypto.randomUUID();
      sessionStorage.setItem(key, JSON.stringify({ payload, requestId }));
      body.set("requestId", requestId);
    };
    private pendingAdmission() {
      const stored = sessionStorage.getItem(`${this.composerTextStorageKey}:admission`);
      let value: unknown;
      try { value = stored === null ? undefined : JSON.parse(stored); } catch { return undefined; }
      return Value.Check(admissionSchema, value) ? value : undefined;
    }
    private readonly promptHistory = new PromptHistoryNavigator();
    private readonly turnRevealed = (event: Event): void => {
      // SAFETY: The agent-turn controller produces this event with the loaded target element.
      this.navigation.reveal((event as CustomEvent<{ target: HTMLElement }>).detail.target);
    };
    private readonly onVisibilityChange = (): void => {
      this.reconcileConnection();
    };
    private readonly cableReady = (): void => {
      this.hasBeenReady = true;
      this.element.dataset.agentPresentationReady = "true";
      void this.revealTranscriptTarget();
      this.setReconnecting(false);
      if (this.connectionShouldRun()) {
        this.setTurnConnectionActive(true);
        this.startAgentTerminals();
      }
      this.element.dispatchEvent(new CustomEvent("live:ready", { bubbles: true }));
      this.navigation.snapshotReady(this.busy);
    };
    private readonly cableDisconnected = (): void => {
      this.element.dataset.agentPresentationReady = "false";
      if (this.cableSubscription) this.setReconnecting(true);
    };
    private readonly cableRejected = (): void => {
      this.element.dataset.agentPresentationReady = "false";
      this.setTurnConnectionActive(false);
      this.setReconnecting(false);
      this.element.dispatchEvent(new CustomEvent("kintsugi:agent-connection-rejected", {
        bubbles: true,
        detail: { workspaceId: this.workspaceIdValue, agentId: this.agentIdValue },
      }));
    };
    private readonly submitting = (event: SubmitEvent): void => {
      if (event.defaultPrevented) return;
      const submittedText = this.inputTarget.value;
      const body = new FormData(this.formTarget);
      this.submittedComposer = {
        text: submittedText,
        attachmentIds: body.getAll("attachment").map(String),
        requestId: String(body.get("requestId")),
        busy: this.busy,
      };
      this.scrollToTranscriptEnd();
    };
    connect(): void {
      this.navigation = new TranscriptNavigation(this.transcriptTarget, this.transcriptContentTarget, this.transcriptEndTarget);
      this.navigation.setStreaming(this.busy);
      this.element.dataset.agentConnectionActive = "false";
      this.element.addEventListener("agent:turn-reveal", this.turnRevealed);
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      this.formTarget.addEventListener("formdata", this.identifySubmission);
      this.formTarget.addEventListener("submit", this.submitting);
      this.composerMutationObserver = new MutationObserver(() => this.updateSendStopButton());
      // Live morphs update the existing button's state attributes without replacing it.
      this.composerMutationObserver.observe(this.formTarget, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-agent-busy", "data-agent-busy-mode", "data-agent-stoppable", "data-agent-abort-form-id"],
      });
      const promptDraft = localStorage.getItem(this.composerTextStorageKey);
      if (promptDraft !== null) this.inputTarget.value = promptDraft;
      this.updateSendStopButton();
      this.connected = true;
      this.element.dataset.agentPresentationReady = "false";
      if (isWorkspacePaneVisible(this.element)) this.becomeVisible();
      else requestAnimationFrame(() => {
        // A lazy mount can connect before its parent's live stream restores selection.
        if (this.connected && !this.logicallyVisible && isWorkspacePaneVisible(this.element)) this.becomeVisible();
      });
    }

    disconnect(): void {
      this.connected = false;
      this.navigation.disconnect();
      this.composerMutationObserver?.disconnect();
      this.element.removeEventListener("agent:turn-reveal", this.turnRevealed);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      this.formTarget.removeEventListener("formdata", this.identifySubmission);
      this.formTarget.removeEventListener("submit", this.submitting);
      this.logicallyVisible = false;
      this.stopConnection();
    }

    inputTargetConnected(input: HTMLTextAreaElement): void {
      if (this.connected) {
        this.promptHistory.inputChanged();
        localStorage.setItem(this.composerTextStorageKey, input.value);
      }
      input.dispatchEvent(new Event("agent-composer:resize", { bubbles: true }));
    }

    becomeVisible(): void {
      this.logicallyVisible = true;
      this.navigation.setVisible(true);
      this.reconcileConnection();
      this.navigation.select(this.busy);
    }

    noLongerVisible(): void {
      this.logicallyVisible = false;
      this.navigation.setVisible(false);
      this.reconcileConnection();
    }

    terminalConnected(terminal: AgentTermControllerInstance): void {
      if (this.connectionShouldRun()) terminal.start();
    }

    private connectionShouldRun(): boolean {
      return agentConnectionShouldRun(this.logicallyVisible, document.visibilityState);
    }

    private reconcileConnection(): void {
      if (!this.connectionShouldRun()) {
        this.stopConnection();
        return;
      }
      if (!this.cableSubscription) this.subscribe();
    }

    private revealedTranscriptTarget?: string;
    private async revealTranscriptTarget(): Promise<void> {
      const params = new URL(location.href).searchParams;
      const message = params.get("agentTarget");
      if (params.get("agent") !== this.agentIdValue || !message || message === this.revealedTranscriptTarget) return;
      this.revealedTranscriptTarget = message;
      const response = await fetch(new URL(`reveal/${encodeURIComponent(message)}`, this.formTarget.action), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Could not reveal transcript target: ${response.status}`);
      const { turnId } = Value.Parse(Type.Object({ turnId: Type.Union([Type.String(), Type.Null()]) }), await response.json());
      if (turnId !== null) {
        const turn = this.transcriptTarget.querySelector<HTMLDetailsElement>(`[data-agent-turn-turn-id-value="${CSS.escape(turnId)}"]`);
        if (turn) {
          turn.dataset.agentTurnRevealValue = message;
          turn.open = true;
        }
      }
      requestAnimationFrame(() => {
        const target = this.transcriptTarget.querySelector<HTMLElement>(`[data-transcript-anchor="${CSS.escape(message)}"], [data-transcript-key="${CSS.escape(message)}"]`);
        if (!target) return;
        this.navigation.reveal(target);
      });
    }

    private subscribe(): void {
      this.element.dataset.agentPresentationReady = "false";
      if (this.hasBeenReady) this.setReconnecting(true);
      this.cableSubscription = window.KintsugiCable?.subscribe(
        this.moduleChannelValue
          ? CableTopics.module(this.moduleChannelValue, this.workspaceIdValue, { agentId: this.agentIdValue })
          : CableTopics.agent(this.workspaceIdValue, this.agentIdValue),
        { onReady: this.cableReady, onDisconnected: this.cableDisconnected, onRejected: this.cableRejected, shownIn: this.element },
      );
    }

    private setTurnConnectionActive(active: boolean): void {
      this.element.dataset.agentConnectionActive = String(active);
      this.element.dispatchEvent(new Event("agent:connection"));
    }

    private stopConnection(): void {
      this.element.dataset.agentPresentationReady = "false";
      this.setTurnConnectionActive(false);
      this.setReconnecting(false);
      this.cableSubscription?.unsubscribe();
      this.cableSubscription = undefined;
      this.stopAgentTerminals();
    }

    private setReconnecting(reconnecting: boolean): void {
      this.transcriptTarget.setAttribute("aria-busy", String(reconnecting));
    }

    private startAgentTerminals(): void {
      this.element.querySelectorAll<HTMLElement>('[data-controller~="agent-term"]').forEach((terminal) => {
        agentTermController(this.application, terminal)?.start();
      });
    }

    private stopAgentTerminals(): void {
      this.element.querySelectorAll<HTMLElement>('[data-controller~="agent-term"]').forEach((terminal) => {
        agentTermController(this.application, terminal)?.stop();
      });
    }

    // ---- transcript navigation ----

    scrollToTranscriptEnd(): void {
      this.navigation.followLatest();
    }

    private userPrompts(): string[] {
      return [...this.transcriptTarget.querySelectorAll<HTMLElement>(".agent-user[data-agent-user-text]")].map((message) => message.dataset.agentUserText!);
    }

    inputKeydown(event: KeyboardEvent): void {
      const completionMenuOpen = Boolean(this.element.querySelector<HTMLElement>(".agent-completion-menu-host:not([hidden])")?.checkVisibility());
      if (!completionMenuOpen && this.promptHistory.keydown(event, this.inputTarget, () => this.userPrompts())) return;

      // Enter inserts a newline on every keyboard; only ⌘/Ctrl+Enter sends.
      if (composerSubmitKey(event)) {
        event.preventDefault();
        if (this.inputTarget.value.trim() || this.formTarget.querySelector(".agent-chip")) {
          const submitter = this.formTarget.querySelector<HTMLButtonElement>('button[name="mode"]');
          this.formTarget.requestSubmit(submitter ?? undefined);
        } else if (!event.repeat) {
          // Sending twice steers: the second press, in the now empty composer, promotes the newest follow-up,
          // or, while the first is still being sent, that one once it's admitted.
          if (this.submittedComposer) this.steerWhenAdmitted = true;
          else this.steerNewestFollowUp();
        }
      }
    }

    private setInputValue(value: string): void {
      setTextInputValue(this.inputTarget, value);
    }

    promptChanged(): void {
      this.promptHistory.inputChanged();
      localStorage.setItem(this.composerTextStorageKey, this.inputTarget.value);
      this.updateSendStopButton();
    }

    private get composerTextStorageKey(): string {
      return agentComposerTextStorageKey(this.workspaceIdValue, this.agentIdValue);
    }

    sendStopTargetConnected(): void {
      this.updateSendStopButton();
    }

    /** The pane's live content, including its actions, can arrive after it connects. */
    private get busy(): boolean {
      return this.hasSendStopTarget && this.sendStopTarget.dataset.agentBusy === "true";
    }

    updateSendStopButton(): void {
      if (!this.hasSendStopTarget) return;
      const button = this.sendStopTarget;
      const busy = button.dataset.agentBusy === "true";
      if (this.connected) this.navigation.setStreaming(busy);
      const busyMode = button.dataset.agentBusyMode === "followUp" ? "followUp" : "steer";
      const action = agentComposerPrimaryAction(busy, this.inputTarget.value, this.formTarget.querySelectorAll('input[name="attachment"]').length, button.dataset.agentStoppable === "true", busyMode);
      if (action === "abort") {
        setActivityButtonState(button, "active");
        button.type = "submit";
        button.removeAttribute("name");
        button.removeAttribute("value");
        button.setAttribute("form", button.dataset.agentAbortFormId ?? "");
        return;
      }
      setActivityButtonState(button, "initial");
      button.type = "submit";
      button.name = "mode";
      button.value = action;
      button.removeAttribute("form");
    }

    async sendPrompt(event: CustomEvent<AgentComposerSendPromptDetail>): Promise<void> {
      try {
        const body = new FormData();
        body.set("text", event.detail.text);
        body.set("mode", "send");
        body.set("requestId", event.detail.requestId ?? crypto.randomUUID());
        body.set("attachmentDraft", String(new FormData(this.formTarget).get("attachmentDraft")));
        const response = await fetch(this.formTarget.action, { method: "POST", body, headers: { Accept: "text/vnd.turbo-stream.html" } });
        if (!response.ok) throw new Error(`Could not send the prompt: HTTP ${response.status}`);
        window.Turbo!.renderStreamMessage(await response.text());
        this.scrollToTranscriptEnd();
        event.detail.onComplete?.();
      } catch (error) {
        if (!event.detail.onComplete) throw error;
        event.detail.onComplete(error instanceof Error ? error : new Error(String(error)));
      }
    }

    /**
     * Turbo accepted the submission (guards and dictation have had their say) and
     * holds its form data: the composer empties, or closes on mobile, right away.
     */
    submitStarted(): void {
      changeLayout(() => {
        this.setInputValue("");
        this.element.dispatchEvent(new Event("agent-composer:sending"));
      });
    }

    submitted(event: TurboSubmitEndEvent): void {
      const submission = this.submittedComposer;
      this.submittedComposer = undefined;
      const steer = this.steerWhenAdmitted;
      this.steerWhenAdmitted = false;
      if (!event.detail.success) {
        // Sending never discards the draft.
        if (submission && !this.inputTarget.value) this.setInputValue(submission.text);
        this.element.dispatchEvent(new Event("agent-composer:failed"));
        return;
      }
      const key = `${this.composerTextStorageKey}:admission`;
      if (submission && this.pendingAdmission()?.requestId === submission.requestId) sessionStorage.removeItem(key);
      if (!this.inputTarget.value) localStorage.removeItem(this.composerTextStorageKey);
      if (event.detail.fetchResponse?.response.headers.get("x-kintsugi-attachment-draft-consumed") === "true") {
        const consumed = new Set(submission?.attachmentIds ?? []);
        this.formTarget.querySelectorAll<HTMLInputElement>('input[name="attachment"]').forEach((input) => {
          if (consumed.has(input.value)) input.closest(".agent-chip")!.remove();
        });
      }
      this.element.dispatchEvent(new Event("agent-composer:sent"));
      const submissionId = event.detail.fetchResponse?.response.headers.get("x-kintsugi-submission-id") ?? undefined;
      // Only input sent while the agent works is queued, and its row may already be shown.
      const queued = submission?.busy && submissionId && !this.transcriptTarget.querySelector(`[data-agent-queued-steer="${CSS.escape(submissionId)}"]`) ? submissionId : undefined;
      this.sentSubmissionId = steer ? undefined : queued;
      if (steer && submissionId) void this.steerQueuedInput(submissionId);
    }

    /** Until the follow-up just sent appears, the newest one on screen is an older one. */
    private steerNewestFollowUp(): void {
      const sent = this.sentSubmissionId;
      this.sentSubmissionId = undefined;
      if (sent) void this.steerQueuedInput(sent).then(steered => { if (!steered) this.clickNewestSteer(); });
      else this.clickNewestSteer();
    }

    private clickNewestSteer(): void {
      [...this.transcriptTarget.querySelectorAll<HTMLButtonElement>("button[data-agent-queued-steer]")].at(-1)?.click();
    }

    queuedSteerTargetConnected(button: HTMLButtonElement): void {
      if (button.dataset.agentQueuedSteer === this.sentSubmissionId) this.sentSubmissionId = undefined;
    }

    /** Whether it was still a queued follow-up; the live view shows the change. */
    private async steerQueuedInput(submissionId: string): Promise<boolean> {
      const response = await fetch(new URL(`queued-inputs/${encodeURIComponent(submissionId)}/steer`, this.formTarget.action), { method: "POST", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Could not steer the follow-up: HTTP ${response.status}`);
      return Value.Parse(steerResponseSchema, await response.json()).input.steered;
    }
  };
}

export function findAgentPaneController(application: StimulusApplication, pane: HTMLElement): AgentPaneControllerInstance | null {
  const agentPane = pane.matches('[data-controller~="agent-pane"]')
    ? pane
    : pane.closest<HTMLElement>('[data-controller~="agent-pane"]') ?? pane.querySelector<HTMLElement>('[data-controller~="agent-pane"]');
  // SAFETY: AgentPaneController is registered under "agent-pane" by builtinAgentClientModule.
  return agentPane ? application.getControllerForElementAndIdentifier(agentPane, "agent-pane") as AgentPaneControllerInstance | null : null;
}

export function registerAgentPaneVisibilityHooks(application: StimulusApplication, hooks: WorkspaceClientHooks): void {
  hooks.onBecomeVisible(({ pane }) => findAgentPaneController(application, pane)?.becomeVisible());
  hooks.onNoLongerVisible(({ pane }) => findAgentPaneController(application, pane)?.noLongerVisible());
}
