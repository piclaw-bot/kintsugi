import { expect, test } from "bun:test";
import { claudeNativeCommands, parseClaudeCommand } from "../src/server/commands.ts";

test("parses the commands this Agent runs itself and leaves every other command to Claude Code", () => {
  expect(parseClaudeCommand("/new")).toEqual({ kind: "new" });
  expect(parseClaudeCommand(" /fork ")).toEqual({ kind: "fork" });
  expect(parseClaudeCommand("/resume")).toEqual({ kind: "resume", sessionId: undefined });
  expect(parseClaudeCommand("/resume 4A3DA9CE-788A-4843-A06A-19DEB284D636")).toEqual({ kind: "resume", sessionId: "4A3DA9CE-788A-4843-A06A-19DEB284D636" });
  expect(parseClaudeCommand("/model haiku")).toEqual({ kind: "model", model: "haiku" });
  for (const text of ["/compact", "/review this", "/newish", "hello /new"]) expect(parseClaudeCommand(text)).toBeUndefined();
  for (const text of ["/new now", "/resume ../../etc", "/model", "/model two words"]) expect(() => parseClaudeCommand(text)).toThrow();
});

test("offers Claude's own commands for completion, except those Kintsugi handles or Prompt templates replace", () => {
  expect(claudeNativeCommands([
    { name: "compact", description: "Compact the conversation", argumentHint: "[instructions]" },
    { name: "review", description: "Review a pull request", argumentHint: "" },
    { name: "model", description: "Set the model", argumentHint: "" },
    { name: "resume", description: "Resume", argumentHint: "" },
    { name: "simplify", description: "Simplify the code", argumentHint: "" },
  ], new Set(["simplify"]))).toEqual([
    { kind: "builtin", source: "claude", name: "compact", trigger: "/compact", description: "Compact the conversation", argumentHint: "[instructions]", preserveArguments: true },
    { kind: "builtin", source: "claude", name: "review", trigger: "/review", description: "Review a pull request", argumentHint: undefined, preserveArguments: true },
  ]);
});
