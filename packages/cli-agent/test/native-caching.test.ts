import { expect, test } from "bun:test";
import { claudeLaunchScript } from "../../claude-cli-agent/src/server/launch-command.ts";
import { codexLaunchScript } from "../../codex-cli-agent/src/server/launch-command.ts";
import { piLaunchScript } from "../../pi-agent/src/server/launch-command.ts";

const input = { text: "Continue", images: [], attachmentNotes: [] };
const session = { id: "12345678-1234-4123-8123-123456789abc", directory: "/home/agent/.local/share/kintsugi-agents/tab", turnSignalCommand: "/home/agent/.local/share/kintsugi-agents/tab/turn-signal.sh" };
const cacheOverrides = /cacheRetention|cache_control|prompt_cache_(?:key|retention)|PI_CACHE_RETENTION|DISABLE_PROMPT_CACHING/i;

test("Claude CLI retains its native session across resume and leaves cache policy to Claude", () => {
  const settings = { model: "anthropic::claude-sonnet-4-5" };
  const initial = claudeLaunchScript(input, [], settings, session), resumed = claudeLaunchScript(input, [], settings, session, true);
  expect(initial).toContain("--session-id"); expect(resumed).toContain("--resume");
  for (const script of [initial, resumed]) { expect(script).toContain(session.id); expect(script).not.toMatch(cacheOverrides); }
});

test("Codex CLI resumes the exact native thread without forcing provider cache settings", () => {
  const nativeId = "87654321-4321-4321-8321-abcdef123456";
  const initial = codexLaunchScript(input, [], { model: "openai-codex::gpt-5.4" }, session);
  const resumed = codexLaunchScript(input, [], { model: "openai-codex::gpt-5.4" }, session, nativeId);
  expect(resumed).toContain(nativeId); expect(resumed).toContain("resume"); expect(resumed).not.toContain("--last");
  for (const script of [initial, resumed]) { expect(script).toContain(session.directory); expect(script).not.toMatch(cacheOverrides); }
});

test("Pi CLI preserves tab-private native sessions and their model/provider defaults", () => {
  const path = `/home/agent/.local/share/pi/sessions/${session.id}/native.jsonl`;
  const initial = piLaunchScript(input, [], { model: "openai::gpt-5.4" }, session);
  const resumed = piLaunchScript(input, [], { model: "openai::gpt-5.4" }, session, path);
  expect(resumed).toContain(path); expect(resumed).toContain("--session");
  for (const script of [initial, resumed]) { expect(script).toContain(session.id); expect(script).not.toMatch(cacheOverrides); }
});
