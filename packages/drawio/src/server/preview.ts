import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { escapeHtml } from "@kintsugi/shared";

export function renderDiagramPreview(xml: string): string {
  const document = new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(xml, "text/xml");
  const root = document.documentElement;
  if (!root || !["mxfile", "mxGraphModel"].includes(root.tagName)) throw new Error("Choose a Draw.io diagram with an mxfile or mxGraphModel root.");
  const serializer = new XMLSerializer();
  const pages = root.tagName === "mxGraphModel"
    ? [{ name: "Page-1", xml: serializer.serializeToString(root) }]
    : Array.from(root.getElementsByTagName("diagram")).filter(page => page.parentNode === root).map(page => {
      const file = root.cloneNode(false);
      file.appendChild(page.cloneNode(true));
      return { name: page.getAttribute("name") || "Untitled page", xml: serializer.serializeToString(file) };
    });
  if (!pages.length) throw new Error("This diagram has no pages.");
  const tabs = pages.map((page, index) => `<button class="drawio-preview-tab" type="button" role="tab" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-drawio-preview-page="${index}" data-action="drawio-preview#selectPage keydown->drawio-preview#navigatePages">${escapeHtml(page.name)}</button>`).join("");
  return `<section class="drawio-preview" data-controller="drawio-preview" data-drawio-preview-pages-value="${escapeHtml(JSON.stringify(pages.map(page => page.xml)))}">
    <div class="drawio-preview-status" role="status" data-drawio-preview-status>Loading preview…</div>
    <iframe title="Draw.io diagram preview" data-drawio-frame src="/drawio/vendor/index.html?embed=1&amp;proto=json&amp;configure=1&amp;chrome=0&amp;pv=0&amp;dark=0&amp;spin=1&amp;nav=1&amp;hide-pages=1&amp;noSaveBtn=1&amp;noExitBtn=1&amp;stealth=1" referrerpolicy="no-referrer"></iframe>
    <div class="drawio-preview-tabs" role="tablist" aria-label="Diagram pages">${tabs}</div>
  </section>`;
}
