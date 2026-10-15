/**
 * Manual recorded-audio acceptance through the real browser capture/controller and ASR backend.
 * Never run by CI. This does NOT verify a physical microphone, permission prompt or iOS keyboard.
 * bun acceptance/dictation-audio.ts --kintsugi http://localhost:3106 --workspace ID --agent ID
 *   --audio /absolute/fixture.wav --expected-suffix "final words must survive" --out artifacts/dictation-audio
 * The isolated acceptance instance must have onboarding dismissed and the workspace running.
 */
import { chromium } from "@playwright/test";
import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { Report } from "./lib/report.ts";
import { check } from "./lib/trace.ts";

const { values } = parseArgs({ options: { kintsugi: { type: "string", default: "http://localhost:3106" }, workspace: { type: "string" }, agent: { type: "string" }, audio: { type: "string" }, "expected-suffix": { type: "string" }, out: { type: "string", default: "artifacts/dictation-audio" } } });
if (!values.workspace || !values.agent || !values.audio || !values["expected-suffix"]) throw new Error("Supply --workspace, --agent, --audio and --expected-suffix");
const audio = Buffer.from(await Bun.file(resolve(values.audio)).arrayBuffer()).toString("base64");
await mkdir(values.out!, { recursive: true });
const report = new Report(values.out!, "Recorded-audio dictation acceptance (not physical microphone)", { app: values.kintsugi!, workspace: values.workspace, audio: basename(values.audio), scope: "Controlled WAV microphone stream; real capture, dictation controller, WebSocket and CPU ASR. No physical device or permission/keyboard acceptance." });
const recorder = await report.scenario("final-words", "Stopping at the end of recorded speech keeps its final words in the visible composer.");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ audio }) => {
    // Controlled audio replaces only the microphone input, not the app's capture or transcription logic.
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      const sourceContext = new AudioContext();
      const samples = Uint8Array.from(atob(audio), character => character.charCodeAt(0));
      const buffer = await sourceContext.decodeAudioData(samples.buffer);
      const destination = sourceContext.createMediaStreamDestination();
      const source = sourceContext.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.onended = () => document.documentElement.setAttribute("data-acceptance-speech-ended", "true");
      await sourceContext.resume();
      setTimeout(() => source.start(), 200);
      return destination.stream;
    } });
  }, { audio });
  await page.goto(`${values.kintsugi}/workspaces/${encodeURIComponent(values.workspace)}?agent=${encodeURIComponent(values.agent)}`, { waitUntil: "domcontentloaded" });
  const composer = page.locator(".agent-composer-pane").filter({ has: page.locator(".composer-input") });
  await composer.locator(".composer-input").waitFor({ state: "visible" });
  await composer.locator(".composer-input").fill("");
  const dictate = composer.locator(".composer-dictation button");
  await dictate.click();
  await page.waitForFunction(() => document.documentElement.getAttribute("data-acceptance-speech-ended") === "true", undefined, { timeout: 600_000 });
  await dictate.click();
  // Finishing returns the control to Dictate only once the final ASR segment has reached the composer.
  await composer.getByRole("button", { name: "Dictate", exact: true }).waitFor({ state: "visible", timeout: 120_000 });
  const transcript = await composer.locator(".composer-input").inputValue();
  const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  recorder.add(check("Final spoken words remain in the visible composer", normalise(transcript).endsWith(normalise(values["expected-suffix"]!)), transcript));
  await recorder.file("transcript.txt", transcript);
  await recorder.file("after.png", await page.screenshot());
} catch (error) {
  recorder.add(check("Recorded-audio scenario completed", false, error instanceof Error ? error.message : String(error)));
} finally {
  await browser.close();
}
const result = await report.write();
console.log(`${result.passed ? "PASS" : "FAIL"} recorded-audio only — ${result.index}`);
process.exitCode = result.passed ? 0 : 1;
