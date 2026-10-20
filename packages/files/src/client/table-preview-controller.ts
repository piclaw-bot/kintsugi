import type { WorkspaceClientControllerConstructor } from "@kintsugi/shared";

export function createTablePreviewController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static targets = ["filter", "row", "summary"];
    declare readonly filterTarget: HTMLInputElement;
    declare readonly rowTargets: HTMLTableRowElement[];
    declare readonly summaryTarget: HTMLElement;
    private caption = "";
    private rows = new Map<HTMLTableRowElement, string>();
    connect() {
      this.caption = this.summaryTarget.textContent ?? "";
      for (const row of this.rowTargets) this.rows.set(row, [...row.querySelectorAll("td")].map(cell => cell.textContent).join("\n").toLocaleLowerCase());
    }
    filter() {
      const query = this.filterTarget.value.toLocaleLowerCase(); let visible = 0;
      for (const [row, text] of this.rows) { row.hidden = !text.includes(query); if (!row.hidden) visible++; }
      this.summaryTarget.textContent = query ? `${visible} matching ${visible === 1 ? "row" : "rows"} · ${this.caption}` : this.caption;
    }
  };
}
