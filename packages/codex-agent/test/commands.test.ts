import { expect, test } from "bun:test";
import { codexSlashCommands, parseCodexCommand } from "../src/server/commands.ts";
import { slashCommands } from "../../agent/src/server/slash-commands.ts";

test("every advertised native command is handled without turning it into a prompt", () => {
  for (const command of codexSlashCommands) expect(parseCodexCommand(command.trigger)?.kind).toBe(command.name);
  expect(parseCodexCommand("ordinary text")).toBeUndefined();
  expect(parseCodexCommand("/name example")).toBeUndefined();
  expect(parseCodexCommand("/my-template")).toBeUndefined();
});

test("review choices retain native target semantics", () => {
  expect(parseCodexCommand("/review")).toEqual({ kind: "review" });
  expect(parseCodexCommand("/review changes")).toEqual({ kind: "review", target: { type: "uncommittedChanges" } });
  expect(parseCodexCommand("/review branch main")).toEqual({ kind: "review", target: { type: "baseBranch", branch: "main" } });
  expect(parseCodexCommand("/review commit abc123")).toEqual({ kind: "review", target: { type: "commit", sha: "abc123", title: null } });
  expect(parseCodexCommand("/review Check correctness\nand race conditions")).toEqual({ kind: "review", target: { type: "custom", instructions: "Check correctness\nand race conditions" } });
  expect(() => parseCodexCommand("/review branch")).toThrow("branch name");
});

test("goals distinguish objectives and lifecycle actions", () => {
  expect(parseCodexCommand("/goal")).toEqual({ kind: "goal", objective: undefined });
  expect(parseCodexCommand("/goal Complete the migration")).toEqual({ kind: "goal", objective: "Complete the migration" });
  expect(parseCodexCommand("/goal pause")).toEqual({ kind: "goal", status: "paused" });
  expect(parseCodexCommand("/goal resume")).toEqual({ kind: "goal", status: "active" });
  expect(parseCodexCommand("/goal complete")).toEqual({ kind: "goal", status: "complete" });
  expect(parseCodexCommand("/goal clear")).toEqual({ kind: "goal", clear: true });
});

test("invalid native command arguments fail instead of becoming inference input", () => {
  for (const command of ["/compact custom instructions", "/fork unexpected", "/mcp unknown", "/resume ../../secrets", "/hooks extra"]) expect(() => parseCodexCommand(command)).toThrow();
  expect(parseCodexCommand(" /mcp verbose \n")).toEqual({ kind: "mcp", verbose: true });
  expect(parseCodexCommand("/skills example")).toEqual({ kind: "skills", name: "example" });
});

test("native commands override conflicting templates without changing CLI defaults", () => {
  const template = { trigger: "/compact", description: "Template", prompt: "Not native compaction", name: "compact", path: "/work/compact.md" };
  const commands = slashCommands([template], [], "cli", codexSlashCommands);
  expect(commands.filter(command => command.trigger === "/compact")).toHaveLength(1);
  expect(commands.find(command => command.trigger === "/compact")?.kind).toBe("builtin");
  expect(slashCommands([], [], "cli").some(command => command.trigger === "/compact")).toBe(false);
});


test("inventory settings preserve explicit native actions", () => {
  expect(parseCodexCommand("/skills disable example")).toEqual({ kind: "skills", name: "example", enabled: false });
  expect(parseCodexCommand("/plugins install example@curated")).toEqual({ kind: "plugins", action: "install", id: "example@curated" });
  expect(parseCodexCommand("/apps enable connector_example")).toEqual({ kind: "apps", enabled: true, id: "connector_example" });
  expect(() => parseCodexCommand("/plugins install")).toThrow();
  expect(() => parseCodexCommand("/apps unexpected")).toThrow();
});

test("command sources reflect execution machinery, not the selected agent", () => {
  const template = { name: "land", trigger: "/land", description: "Land changes", prompt: "Finish these changes" };
  const native = slashCommands([template], [], "cli", codexSlashCommands);
  expect(native.find(command => command.trigger === "/land")?.source).toBe("kintsugi");
  expect(native.find(command => command.trigger === "/name")?.source).toBe("kintsugi");
  expect(native.find(command => command.trigger === "/new")?.source).toBe("codex");
  expect(native.find(command => command.trigger === "/park")?.source).toBe("kintsugi");
  expect(native.find(command => command.trigger === "/compact")?.source).toBe("codex");
  expect(native.find(command => command.trigger === "/skills")?.source).toBe("codex");
  for (const command of codexSlashCommands) expect(command.source).toBe("codex");
  expect(slashCommands([], [], "builtin").find(command => command.trigger === "/compact")?.source).toBe("kintsugi");
});
