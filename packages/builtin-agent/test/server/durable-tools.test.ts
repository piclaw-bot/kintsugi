import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createDurableWorkspaceTools, durableWorkspaceTool } from "../../src/server/durable-tools.ts";
import { openDurableWorkspace, type DurableWorkspace } from "../../src/server/durable-workspace.ts";
import { defineWorkspaceTool, type WorkspaceTool } from "@kintsugi/agent/server/workspace-tool";
import { registerWorkspacePresenter } from "@kintsugi/agent/server/tools";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const workspaces: DurableWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "kintsugi-durable-tools-"));
  directories.push(path);
  return path;
}

async function runTool(tool: WorkspaceTool<any, any>, args: Record<string, JsonValue>) {
  const path = await directory();
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(tool.name, args)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "workspace-tools", tools: [durableWorkspaceTool(tool)] }));
  const workspace = await openDurableWorkspace(path, "test-workspace", { models, registry });
  workspaces.push(workspace);
  const conversation = await workspace.agent({ agentId: "tab", label: "Agent 1", title: "Tools" }, {
    model: { provider: "faux", modelId: "faux-1" },
  });
  const submission = await conversation.submit({ type: "input", content: "Use the tool", requestId: "request" }, context);
  expect((await submission.wait(context)).status).toBe("done");
  const entries = (await conversation.entries({}, 100, undefined, context)).items;
  const messages = entries.flatMap((entry) => entry.model ?? []);
  const result = messages.find((message) => message.role === "toolResult");
  expect(result?.role).toBe("toolResult");
  await workspace.close();
  const reopened = await openDurableWorkspace(path, "test-workspace", { models, registry });
  workspaces.push(reopened);
  const restored = await reopened.agent({ agentId: "tab", label: "Agent 1", title: "Tools" });
  expect((await restored.entries({}, 100, undefined, context)).items).toEqual(entries);
  await reopened.close();
  return { result: result!, journal: await readFile(join(path, "main.jsonl"), "utf8") };
}

test("assembly opts only the observational read into replay and excludes legacy bash", () => {
  const unregister = registerWorkspacePresenter("test-browser", () => ({
    kind: "test-browser", description: "Browser", parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "Presented" }], details: {} }),
  }));
  try {
    const tools = createDurableWorkspaceTools("workspace", createModels());
    expect(tools.map((tool) => [tool.name, tool.replay])).toEqual([
      ["read", "safe"], ["write", "unsafe"], ["edit", "unsafe"], ["present", "unsafe"],
    ]);
    expect(tools.find((tool) => tool.name === "present")!.description).toContain("artifact-preview:");
  } finally {
    unregister();
  }
  // A registered tool named read does not inherit the built-in's replay policy.
  expect(durableWorkspaceTool(defineWorkspaceTool({
    name: "read", label: "Read", description: "Not necessarily observational", parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  })).replay).toBe("unsafe");
});

test("native Harness executes SDK file mutations and retains searchable read output", async () => {
  const cwd = await directory();
  const path = join(cwd, "example.txt");
  const write = await runTool(createWriteTool(cwd), { path, content: "before\nsecond\n" });
  expect(write.result.isError).toBe(false);
  expect(await readFile(path, "utf8")).toBe("before\nsecond\n");
  const edit = await runTool(createEditTool(cwd), { path, edits: [{ oldText: "before", newText: "after" }] });
  expect(edit.result.isError).toBe(false);
  expect(edit.journal).toContain("firstChangedLine");
  expect(await readFile(path, "utf8")).toBe("after\nsecond\n");
  const read = await runTool(createReadTool(cwd), { path, offset: 2, limit: 1 });
  expect(read.result.isError).toBe(false);
  expect(read.result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("second") });
  expect(read.journal).toContain("second");
});

test("images survive the native Harness tool result and fsynced journal", async () => {
  const cwd = await directory();
  const path = join(cwd, "pixel.png");
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";
  await writeFile(path, Buffer.from(base64, "base64"));
  const { result, journal } = await runTool(createReadTool(cwd, { autoResizeImages: false }), { path });
  expect(result.isError).toBe(false);
  expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: base64 });
  expect(journal).toContain(base64);
});

test("invalid tool input and execution failures become durable errors, not effects or lost tasks", async () => {
  let executed = false;
  const tool = defineWorkspaceTool({
    name: "effect", label: "Effect", description: "Test", parameters: Type.Object({ value: Type.String() }),
    async execute() { executed = true; throw new Error("workspace unavailable"); },
  });
  const invalid = await runTool(tool, {});
  expect(invalid.result.isError).toBe(true);
  expect(executed).toBe(false);
  const failed = await runTool(tool, { value: "valid" });
  expect(executed).toBe(true);
  expect(failed.result.isError).toBe(true);
  expect(failed.journal).toContain("workspace unavailable");
});

test("SDK snapshot updates and final details are committed without repeating output", async () => {
  const { result, journal } = await runTool(defineWorkspaceTool({
    name: "progress", label: "Progress", description: "Test", parameters: Type.Object({}),
    async execute(callId, _args, signal, update) {
      expect(callId.length).toBeGreaterThan(0);
      expect(signal?.aborted).toBe(false);
      update?.({ content: [{ type: "text", text: "working" }], details: { step: 1 } });
      update?.({ content: [{ type: "text", text: "working more" }], details: { step: 2 } });
      return { content: [{ type: "text", text: "finished" }], details: { step: 3 } };
    },
  }), {});
  expect(result.content).toEqual([{ type: "text", text: "finished" }]);
  expect(journal).toContain('"step":3');
});
