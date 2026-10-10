import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@kintsugi/shared";

export function createAgentElapsedController(Controller: StimulusControllerConstructor) {
  return class AgentElapsedController extends Controller {
    static values = { since: Number, prefix: String, suffix: String, format: String };
    static targets = ["time"];
    declare readonly sinceValue: number;
    declare readonly prefixValue: string;
    declare readonly suffixValue: string;
    declare readonly formatValue: string;
    declare readonly timeTargets: HTMLElement[];
    private timer?: ReturnType<typeof setInterval>;

    connect(): void {
      const format = (seconds: number): string => {
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const rest = seconds % 60;
        if (this.formatValue === "duration") {
          if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
          return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
        }
        return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, "0")}`;
      };
      const update = () => {
        const seconds = Math.max(0, Math.round((Date.now() - this.sinceValue) / 1000));
        for (const target of this.timeTargets) target.textContent = `${this.prefixValue}${format(seconds)}${this.suffixValue}`;
      };
      update();
      this.timer = setInterval(update, 1000);
    }

    disconnect(): void {
      if (this.timer) clearInterval(this.timer);
    }
  };
}

