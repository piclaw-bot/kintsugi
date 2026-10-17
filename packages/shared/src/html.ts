export function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "�")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type TurboStreamAction = "append" | "prepend" | "before" | "replace" | "update" | "remove";

export function turboStream(action: TurboStreamAction, target: string, html = "", options: { targets?: boolean; method?: "morph" } = {}): string {
  const targetAttribute = options.targets ? "targets" : "target";
  const targetValue = escapeHtml(target);
  const method = options.method ? ` method="${options.method}"` : "";
  if (action === "remove") return `<turbo-stream action="remove" ${targetAttribute}="${targetValue}"${method}></turbo-stream>`;
  return `<turbo-stream action="${action}" ${targetAttribute}="${targetValue}"${method}><template>${html}</template></turbo-stream>`;
}
