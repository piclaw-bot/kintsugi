/** Manual cold-viewer reopen benchmark against a running app; not part of CI.
 * bun acceptance/terminal-startup.ts --workspace <id> [--out /persistent/…]
 * Each sample switches away, disposing the viewer, then measures until its
 * first terminal output is painted. First-open and warm reopen are separate.
 */
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { ChromePage } from "./lib/cdp.ts";

const { values: args } = parseArgs({ options: {
  kintsugi: { type: "string", default: "http://localhost:3000" },
  cdp: { type: "string", default: "http://127.0.0.1:9222" },
  workspace: { type: "string" },
  samples: { type: "string", default: "12" },
  out: { type: "string", default: `/persistent/acceptance-reports/terminal-startup-${Date.now()}` },
} });
if (!args.workspace) throw new Error("--workspace is required (stage a Terminal and another Work view first)");
const response = await fetch(`${args.kintsugi}/workspaces/${args.workspace}`, { headers: { Accept: "application/json" } });
if (!response.ok) throw new Error(await response.text());
// SAFETY: The running app's documented workspace detail contract.
const { workspace } = await response.json() as { workspace: { workViews: { key: string; reference: { type: string } }[] } };
const terminal = workspace.workViews.find(view => view.reference.type === "terminal")!;
const other = workspace.workViews.find(view => view.reference.type !== "terminal")!;
if (!terminal || !other) throw new Error("Stage a Terminal and another Work view first");
await mkdir(args.out, { recursive: true });
const page = await ChromePage.open(args.cdp);
await page.cdp.send("Page.bringToFront");
// Observe output delivery without changing transport or renderer scheduling.
// Track only this Terminal view, not terminals embedded in the Agent pane.
await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      if (!new URL(args[0], location.href).pathname.endsWith(${JSON.stringify(`/views/${encodeURIComponent(terminal.key)}/ws`)})) return;
      const firstPaint = window.__terminalFirstPaint;
      this.addEventListener('message', (event) => {
        if (typeof event.data !== 'string' && firstPaint && firstPaint.firstOutputAt === undefined) firstPaint.firstOutputAt = performance.now();
      });
    }
  };
})();` });
const results = [];
try {
  for (const layout of ["desktop", "mobile"] as const) {
    await page.layout(layout);
    await page.navigate(`${args.kintsugi}/workspaces/${args.workspace}?workView=${encodeURIComponent(other.key)}`, ".fixed-workspace-presentation");
    const samples = [];
    for (let i = 0; i <= Number(args.samples); i++) {
      // Use the real selection action. The mobile bar and desktop tabs share it.
      await page.evaluate(`document.querySelector('button[data-work-view-key=${JSON.stringify(other.key)}]').click()`);
      await Bun.sleep(200);
      const resizesBefore = page.resizes.length;
      const sample = await page.evaluate<{ paintedMs: number; connectedMs?: number; outputToPaintedMs?: number }>(`new Promise((resolve, reject) => {
        const pane = document.querySelector('[data-workspace-pane-role="work"][data-workspace-pane-id=${JSON.stringify(terminal.key)}]');
        const firstPaint = window.__terminalFirstPaint = {};
        const started = performance.now();
        let connectedMs;
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Terminal did not paint within 10s")); }, 10000);
        const observer = new MutationObserver(() => {
          if (connectedMs === undefined && pane.querySelector('[data-terminal-connection-state]')?.closest('[data-state]')?.getAttribute('data-state') === 'connected') connectedMs = performance.now() - started;
          if (!pane.querySelector('.observable-terminal-painted')) return;
          observer.disconnect();
          requestAnimationFrame(() => {
            clearTimeout(timeout);
            resolve({ paintedMs: performance.now() - started, connectedMs, outputToPaintedMs: firstPaint.firstOutputAt === undefined ? undefined : performance.now() - firstPaint.firstOutputAt });
          });
        });
        observer.observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-state'] });
        document.querySelector('button[data-work-view-key=${JSON.stringify(terminal.key)}]').click();
      })`);
      samples.push({ ...sample, resizeMessages: page.resizes.length - resizesBefore });
      console.log(`${layout} ${i === 0 ? "first" : `reopen ${i}`}: ${sample.paintedMs.toFixed(1)}ms`);
    }
    const reopen = samples.slice(1).map(sample => sample.paintedMs).sort((a, b) => a - b);
    const medianMs = (reopen[Math.floor((reopen.length - 1) / 2)]! + reopen[Math.floor(reopen.length / 2)]!) / 2;
    const viewport = await page.evaluate<{ width: number; height: number; devicePixelRatio: number }>(`({ width: innerWidth, height: innerHeight, devicePixelRatio })`);
    results.push({ layout, viewport, first: samples[0], medianMs, p95Ms: reopen[Math.ceil(reopen.length * 0.95) - 1], samples });
    await Bun.write(`${args.out}/${layout}.png`, await page.screenshot());
  }
  await Bun.write(`${args.out}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ samples: _, ...summary }) => summary), null, 2));
  console.log(`Report: ${args.out}/results.json`);
} finally {
  await page.close();
}
