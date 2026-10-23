import { expect, test } from "bun:test";
import { formatBashOutput } from "../../src/server/bash-tool.ts";

test("passes output within the limits through unchanged", () => {
  const plainLines = Array.from({ length: 100 }, (_, index) => `  line ${index + 1}`);
  const ansi = plainLines.map((line) => `\u001b[32m${line}\u001b[0m`).join("\n");

  const result = formatBashOutput(plainLines.join("\n"), ansi, "/tmp/full.txt");

  expect(result).toEqual({ output: plainLines.join("\n"), displayAnsi: ansi, modelTruncated: false });
});

test("keeps the tail within Pi's 50 KiB and 2000-line model limits, with room for the notice and exit status", () => {
  const lines = Array.from({ length: 2100 }, (_, index) => String(index + 1).padStart(4, "0"));
  const text = lines.join("\n");

  const result = formatBashOutput(text, text, "/tmp/full.txt");
  const output = result.output;

  expect(`${output}\n\nCommand exited with code 1`.split("\n").length).toBeLessThanOrEqual(2000);
  expect(output).toStartWith(lines[104]);
  expect(output).not.toContain(lines[103]);
  expect(output).toContain(lines[2099]);
  expect(output).toContain("[Output truncated: showing the last");
  expect(output).toContain("Full output: /tmp/full.txt]");
  expect(result.displayAnsi).toEndWith(output.slice(output.indexOf("[Output truncated:")));
});

test("limits model-facing output to the last 50 KiB", () => {
  const lines = Array.from({ length: 700 }, (_, index) => `${String(index + 1).padStart(4, "0")}:${"x".repeat(90)}`);
  const text = lines.join("\n");

  const output = formatBashOutput(text, text, "/tmp/full.txt").output;

  expect(Buffer.byteLength(`${output}\n\nCommand exited with code 1`)).toBeLessThanOrEqual(50 * 1024);
  expect(output).not.toContain(lines[0]);
  expect(output).toContain(lines[699]);
  expect(output).toContain("[Output truncated: showing the last 48.9KB of output");
});

test("shortens individual model-facing lines to 500 characters and retains the full output path", () => {
  const longLine = "a".repeat(700);

  const result = formatBashOutput(longLine, longLine, "/tmp/full.txt");
  const output = result.output;

  expect(output).toStartWith(`${"a".repeat(500)}... [truncated]`);
  expect(output).toContain("1 line shortened to 500 characters");
  expect(output).toContain("Full output: /tmp/full.txt]");
  expect(result.displayAnsi).toEndWith(output.slice(output.indexOf("[Output truncated:")));
});
