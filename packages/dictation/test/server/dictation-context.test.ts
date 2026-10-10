import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTranscriptionContext, readDictationContext } from "../../src/server/dictation-context.ts";

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test("reads one phrase per line, ignoring comments and blank lines", async () => {
  root = await mkdtemp(join(tmpdir(), "transcription-context-"));
  expect(await readDictationContext(root)).toEqual([]);
  await mkdir(join(root, ".kintsugi"));
  await writeFile(join(root, ".kintsugi", "dictation-context"), "# Terms\r\nClaude Code # product\r\n\r\n  Nemotron  \r\n");
  expect(await readDictationContext(root)).toEqual(["Claude Code", "Nemotron"]);
});

test("adds the words to the realtime session update without changing other messages", () => {
  const message = JSON.stringify({ type: "session.update", session: { sample_rate: 48000, language: "auto" } });
  expect(JSON.parse(addTranscriptionContext(message, ["Claude Code", "Kintsugi"]))).toEqual({
    type: "session.update", session: { sample_rate: 48000, language: "auto", speech_contexts: [{ phrases: ["Claude Code", "Kintsugi"], boost: 3 }] },
  });
  expect(addTranscriptionContext(message, [])).toBe(message);
  const commit = JSON.stringify({ type: "input_audio_buffer.commit" });
  expect(addTranscriptionContext(commit, ["Kintsugi"])).toBe(commit);
});


test("reads older phrase hints and prefers the canonical Dictation file, including an empty file", async () => {
  root = await mkdtemp(join(tmpdir(), "dictation-context-"));
  await mkdir(join(root, ".kintsugi"));
  await writeFile(join(root, ".kintsugi", "transcription-context"), "Older term\n");
  expect(await readDictationContext(root)).toEqual(["Older term"]);
  await writeFile(join(root, ".kintsugi", "dictation-context"), "Current term\n");
  expect(await readDictationContext(root)).toEqual(["Current term"]);
  await writeFile(join(root, ".kintsugi", "dictation-context"), "");
  expect(await readDictationContext(root)).toEqual([]);
});
