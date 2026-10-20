import type { JsonObject } from "@kintsugi/core";
/* Manual acceptance only, never run by tests or CI. Drives a disposable Kintsugi.
 * bun acceptance/agent-plan.ts --kintsugi http://localhost:3122 --workspace ID --agent-a ID --agent-b ID --out artifacts/plan-review/acceptance
 * Checks visible plan content and persisted operations, not rendered markup.
 */
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
const { values } = parseArgs({ options: { kintsugi: { type: "string", default: "http://localhost:3122" }, workspace: { type: "string" }, "agent-a": { type: "string" }, "agent-b": { type: "string" }, out: { type: "string", default: "artifacts/plan-review/acceptance" } } });
const workspace = values.workspace!, a = values["agent-a"]!, b = values["agent-b"]!;
if (!workspace || !a || !b) throw new Error("Choose a disposable workspace and two Agents");
await mkdir(values.out, { recursive: true });
const base = values.kintsugi, headers = { Accept: "application/json", "Content-Type": "application/json", Origin: new URL(base).origin };
async function api(agent: string, body?: JsonObject) {
  const response = await fetch(`${base}/workspaces/${workspace}/agent-plans/${agent}`, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`Plan API ${response.status}: ${await response.text()}`);
  return (await response.json()).plan;
}
const originalA = await api(a), originalB = await api(b);
const checks: { name: string; passed: boolean; detail?: string }[] = [];
function check(name: string, passed: boolean, detail?: string) { checks.push({ name, passed, detail }); console.log(`${passed ? "PASS" : "FAIL"} ${name}`); if (!passed) throw new Error(name); }
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = `${base}/workspaces/${workspace}?agent=${a}&workView=plan:plan`;
  await page.goto(url); const editor = () => page.getByRole("textbox", { name: "Agent plan Markdown" });
  async function select(agent: string) { await page.locator(`[data-agent-id="${agent}"]`).first().click(); await page.waitForTimeout(350); }
  async function visible(text: string) { for (let i = 0; i < 80; i++) { if ((await editor().inputValue()).includes(text)) return true; await page.waitForTimeout(100); } return false; }
  await page.waitForTimeout(900);
  check("Agent A loads its saved plan", (await editor().inputValue()) === originalA.markdown);
  const draftA = originalA.markdown + "\n- [ ] Keep my unsaved draft A";
  await editor().fill(draftA);
  await api(a, { action: "patch", patches: [{ operation: "add", step: "Remote update A" }] }); await page.waitForTimeout(500);
  check("Remote changes do not overwrite dirty text", (await editor().inputValue()) === draftA);
  await page.getByRole("button", { name: "Save", exact: true }).click(); await page.waitForTimeout(350);
  check("Stale save preserves the draft", (await editor().inputValue()) === draftA);
  check("Stale save does not overwrite the saved plan", (await api(a)).markdown.includes("Remote update A"));
  await select(b); check("Agent B has an independent plan", (await editor().inputValue()) === originalB.markdown);
  const draftB = originalB.markdown + "\n- [ ] Keep my unsaved draft B"; await editor().fill(draftB);
  await select(a); check("Switching Agents restores draft A", (await editor().inputValue()) === draftA);
  await page.getByRole("button", { name: "Refresh", exact: true }).click(); await page.getByRole("button", { name: "Continue", exact: true }).click();
  check("Explicit Refresh loads the newer saved version", await visible("Remote update A"));
  const savedA = (await editor().inputValue()) + "\n- [ ] User saved step"; await editor().fill(savedA); await page.getByRole("button", { name: "Save", exact: true }).click(); await page.waitForTimeout(400);
  check("User Save persists Markdown", (await api(a)).markdown === savedA);
  await api(a, { action: "patch", patches: [{ operation: "add", step: "Clean live update" }] });
  check("Clean pane follows live model/API changes", await visible("Clean live update"));
  // Delay only delivery of a successful save response, then keep typing.
  let delayed = true;
  await page.route(`**/agent-plans/${a}`, async route => {
    if (delayed && route.request().method() === "POST") { delayed = false; const response = await route.fetch(); await new Promise(resolve => setTimeout(resolve, 600)); await route.fulfill({ response }); }
    else await route.continue();
  });
  const beforeTyping = await editor().inputValue();
  await editor().fill(beforeTyping + "\n- [ ] Saved first version");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(150); const whileSaving = beforeTyping + "\n- [ ] Saved first version\n- [ ] Typed while saving";
  await editor().fill(whileSaving); await page.waitForTimeout(800);
  check("Typing during Save is not overwritten by the response", (await editor().inputValue()) === whileSaving);
  check("Only the submitted snapshot was saved", !(await api(a)).markdown.includes("Typed while saving"));
  await page.unroute(`**/agent-plans/${a}`);
  await page.getByRole("button", { name: "Save", exact: true }).click(); await page.waitForTimeout(350);
  check("Newer edits can be saved against the acknowledged revision", (await api(a)).markdown === whileSaving);
  await select(b); check("Draft B survives activity on A", (await editor().inputValue()) === draftB);
  await page.reload(); await page.waitForTimeout(1000); check("Unsaved draft survives a browser reload", (await editor().inputValue()) === draftB);
  await select(a);
  const beforeInvalid = await api(a); await editor().fill("- [-] One\n- [-] Two"); await page.getByRole("button", { name: "Save", exact: true }).click(); await page.waitForTimeout(350);
  check("Invalid two-in-progress edit remains available to fix", (await editor().inputValue()) === "- [-] One\n- [-] Two");
  check("Invalid edit leaves saved state unchanged", (await api(a)).revision === beforeInvalid.revision);
  await page.getByRole("button", { name: "Refresh", exact: true }).click(); await page.getByRole("button", { name: "Continue", exact: true }).click(); await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Reset", exact: true }).click(); await page.getByRole("button", { name: "Cancel", exact: true }).click();
  check("Cancelling Reset preserves the saved plan", (await api(a)).revision === beforeInvalid.revision);
  await page.getByRole("button", { name: "Reset", exact: true }).click(); await page.getByRole("button", { name: "Continue", exact: true }).click();
  check("Confirmed Reset restores the canonical default", await visible("Clarify the current objective"));
  check("Reset does not change Agent B", (await api(b)).markdown === originalB.markdown);
  await editor().fill(""); await page.getByRole("button", { name: "Save", exact: true }).click(); await page.waitForTimeout(300); await page.reload(); await page.waitForTimeout(800);
  check("An intentionally empty plan stays empty after reload", (await editor().inputValue()) === "" && (await api(a)).markdown === "");
  await api(a, { action: "write", markdown: originalA.markdown }); await page.waitForTimeout(500);
  await page.screenshot({ path: join(values.out, "desktop.png") });
  await page.setViewportSize({ width: 393, height: 852 }); await page.waitForTimeout(350); const work = page.getByRole("button", { name: "Work", exact: true }); if (await work.count()) await work.click(); await page.waitForTimeout(250);
  await page.screenshot({ path: join(values.out, "mobile.png") });
  check("No browser runtime errors", errors.length === 0, errors.join("; "));
} finally {
  await browser.close(); await api(a, { action: "write", markdown: originalA.markdown }); await api(b, { action: "write", markdown: originalB.markdown });
  await Bun.write(join(values.out, "report.json"), JSON.stringify({ manual: true, scope: "Disposable two-Agent plan editing; no inference, CLI sending or physical soft keyboard acceptance", checks }, null, 2) + "\n");
}
