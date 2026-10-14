import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep transport mocks and workspace metadata isolated from other packages.
async function scenario(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "claude-runtime-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      import { mkdirSync, writeFileSync } from "node:fs";
      const connections = [];
      const launchSettings = { model: "anthropic::claude-opus-5-5", thinkingLevel: "medium" };
      const models = [
        { value: "default", displayName: "Default (recommended)", description: "" },
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportedEffortLevels: ["low", "medium", "high", "max"] },
        { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "", supportedEffortLevels: ["low", "medium"] },
      ];
      const sessions = agentId => process.env.ATELIER_DATA_DIR + "/workspaces/workspace/home-local/.local/share/kintsugi-agents/" + agentId + "/claude/projects/-work";
      const record = (agentId, id, rows) => { mkdirSync(sessions(agentId), { recursive: true }); writeFileSync(sessions(agentId) + "/" + id + ".jsonl", rows.map(row => JSON.stringify(row)).join("\\n")); };
      mock.module(${JSON.stringify(join(import.meta.dir, "../src/server/setup.ts"))}, () => ({
        agentTypeId: "claude", label: "Claude Code", requireSetup: async () => {},
        prepareClaude: async () => ({ instructions: "instructions" }),
        settings: { prepare: async () => ({ ...launchSettings }), renderFooter: async () => "" },
      }));
      mock.module(${JSON.stringify(join(import.meta.dir, "../src/server/transport.ts"))}, () => ({
        openClaudeTransport: async (workspaceId, agentId, start, message, failed) => {
          const connection = { start, message, failed, sent: [], calls: [], closed: false,
            send(value) { this.sent.push(value); },
            query: {
              initializationResult: async () => ({ models, commands: [{ name: "compact", description: "Compact", argumentHint: "" }, { name: "model", description: "Model", argumentHint: "" }] }),
              getContextUsage: async () => ({ percentage: 12 }),
              async interrupt() { connection.calls.push(["interrupt"]); },
              async stopTask(taskId) { connection.calls.push(["stopTask", taskId]); },
              async setModel(model) { connection.calls.push(["setModel", model]); },
              async applyFlagSettings(settings) { connection.calls.push(["applyFlagSettings", settings]); },
            },
            async close() { this.closed = true; } };
          connections.push(connection);
          return connection;
        },
      }));
      const rendering = await import(${JSON.stringify(join(import.meta.dir, "../src/server/render.ts"))});
      mock.module(${JSON.stringify(join(import.meta.dir, "../src/server/render.ts"))}, () => ({ ...rendering, liveRegions: () => [] }));
      mock.module("@kintsugi/agent/server/completion-catalog", () => ({ renderWorkspaceCompletionCatalog: async () => "" }));
      const busy = await import("@kintsugi/agent/server");
      const busyEvents = [];
      mock.module("@kintsugi/agent/server", () => ({ ...busy, publishWorkspaceAgentBusy(event) { busyEvents.push(event.busy); }, revokeAgentMcp: async () => {} }));
      const llm = await import("@kintsugi/llm/server");
      const preferences = [];
      mock.module("@kintsugi/llm/server", () => ({ ...llm, setAgentModelPreference: async (...args) => preferences.push(args) }));
      const finished = [];
      const events = { on() {}, async emit(name, payload) { if (name === "workspace_agent_turn_finished") finished.push(payload.agentId); } };
      const { createClaudeAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/runtime.ts"))});
      const agents = createClaudeAgents(() => events);
      const input = { text: "hello", images: [], attachmentNotes: [] };
      const result = (extra = {}) => ({ type: "result", subtype: "success", modelUsage: {}, queued_turn_count: 0, uuid: crypto.randomUUID(), session_id: "s", ...extra });
      ${script}
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ATELIER_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("a launch prompt starts a new native session once, and retries of a send are not delivered twice", () => scenario(`
  const id = await agents.create("workspace", { input });
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  expect(connection.start).toMatchObject({ sessionId: runtime.record.sessionId, model: "claude-opus-5-5", effort: "medium", instructions: "instructions" });
  expect(connection.start.resume).toBeUndefined();
  expect(connection.sent).toHaveLength(1);
  expect(connection.sent[0]).toMatchObject({ type: "user", session_id: "", parent_tool_use_id: null, origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: "hello" }] } });
  expect(connection.sent[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(runtime.isBusy).toBe(true);
  connection.message(result());
  expect(runtime.isBusy).toBe(false);
  expect(busyEvents).toEqual([true, false]);
  expect(finished).toEqual([id]);
  await runtime.send({ text: "again", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }], attachmentNotes: ["Attached notes.md"] }, "request");
  await runtime.send({ text: "again", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }], attachmentNotes: ["Attached notes.md"] }, "request");
  expect(connection.sent).toHaveLength(2);
  expect(connection.sent[1].message.content).toEqual([{ type: "text", text: "again\\n\\nAttached notes.md" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]);
  await expect(runtime.send({ ...input, text: "different" }, "request")).rejects.toMatchObject({ code: "invalid_arguments" });
  await agents.disposeAll();
`));

test("prompts sent while Claude works steer its turn, and queued prompts keep it busy", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  await runtime.send(input, "first");
  await runtime.send({ ...input, text: "also this" }, "second");
  expect(runtime.state.rows.map(row => row.kind)).toEqual(["user", "steer"]);
  connection.message(result({ queued_turn_count: 1 }));
  expect(runtime.isBusy).toBe(true);
  connection.message(result());
  expect(runtime.isBusy).toBe(false);
  await agents.disposeAll();
`));

test("background work keeps Claude busy until it has reported on it", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  const system = (subtype, extra) => ({ type: "system", subtype, uuid: crypto.randomUUID(), session_id: "s", ...extra });
  const tasks = list => system("background_tasks_changed", { tasks: list });
  await runtime.send(input, "first");
  connection.message(tasks([{ task_id: "suite", task_type: "local_bash", description: "Run the suite" }, { task_id: "watcher", task_type: "monitor", description: "Watch", ambient: true }]));
  connection.message(result());
  expect(runtime.isBusy).toBe(true);
  expect(finished).toEqual([]);
  connection.message(system("task_notification", { task_id: "suite", status: "completed", output_file: "", summary: "" }));
  connection.message(tasks([{ task_id: "watcher", task_type: "monitor", description: "Watch", ambient: true }]));
  expect(runtime.isBusy).toBe(true);
  connection.message({ type: "stream_event", event: { type: "message_start", message: { id: "follow-up" } }, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "s" });
  connection.message(result());
  expect(runtime.isBusy).toBe(false);
  expect(busyEvents).toEqual([true, false]);
  expect(finished).toEqual([id]);
  await runtime.send(input, "second");
  connection.message(tasks([{ task_id: "server", task_type: "local_bash", description: "Serve" }]));
  connection.message(result());
  await runtime.stop();
  expect(connection.calls).toEqual([["stopTask", "server"]]);
  connection.message(system("task_notification", { task_id: "server", status: "stopped", output_file: "", summary: "" }));
  connection.message(tasks([]));
  expect(runtime.isBusy).toBe(false);
  expect(finished).toEqual([id, id]);
  await agents.disposeAll();
`));

test("stopping interrupts Claude without reporting its abort as a problem", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  await runtime.stop();
  expect(connection.calls).toEqual([]);
  await runtime.send(input, "first");
  await runtime.stop();
  expect(connection.calls).toEqual([["interrupt"]]);
  connection.message(result({ subtype: "error_during_execution", errors: ["Request was aborted"] }));
  connection.message({ type: "result", subtype: "error_during_execution", errors: ["[ede_diagnostic] result_type=user"], modelUsage: {}, uuid: crypto.randomUUID(), session_id: "s" });
  expect(runtime.state.notices).toEqual([]);
  await runtime.send(input, "second");
  connection.message(result({ subtype: "error_max_turns", errors: ["Reached the maximum number of turns"] }));
  expect(runtime.state.notices).toEqual(["Reached the maximum number of turns"]);
  await agents.disposeAll();
`));

test("model and effort changes use Claude's own catalog and apply to the running session", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const [connection] = connections;
  expect(runtime.selectedModel.value).toBe("opus");
  expect(runtime.selection.models.map(model => model.name)).toEqual(["Default (recommended)", "Claude Opus 5.5", "Claude Haiku 5.5"]);
  expect(runtime.selection.thinkingLevels).toEqual(["low", "medium", "high", "max"]);
  expect(runtime.contextPercent).toBe(12);
  await runtime.configure({ thinkingLevel: "max" });
  await runtime.configure({ model: "anthropic::haiku" });
  expect(connection.calls).toEqual([["applyFlagSettings", { effortLevel: "max" }], ["setModel", "haiku"], ["applyFlagSettings", { effortLevel: "medium" }]]);
  expect(runtime.record).toMatchObject({ model: "anthropic::claude-haiku-5-5", thinkingLevel: "medium" });
  expect(preferences.at(-1)).toEqual(["claude", { provider: "anthropic", id: "claude-haiku-5-5" }, "medium"]);
  await expect(runtime.configure({ thinkingLevel: "max" })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(runtime.configure({ model: "openai-codex::gpt" })).rejects.toMatchObject({ code: "invalid_arguments" });
  expect(await runtime.command({ kind: "model", model: "opus" }, "model")).toEqual({ kind: "done", message: "Using Claude Opus 5.5." });
  await runtime.send(input, "busy");
  await expect(runtime.configure({ model: "anthropic::opus" })).rejects.toMatchObject({ code: "invalid_arguments" });
  await agents.disposeAll();
`));

test("new, fork and resume switch between the Agent's own native sessions", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const original = runtime.record.sessionId;
  await expect(runtime.command({ kind: "fork" }, "early-fork")).rejects.toMatchObject({ code: "invalid_arguments" });
  record(id, original, [{ type: "user", uuid: "prompt", timestamp: "2026-10-12T12:00:00.000Z", message: { role: "user", content: "Remember this" } }]);
  // A refused command leaves its request ID free for a retry.
  expect(await runtime.command({ kind: "fork" }, "early-fork")).toEqual({ kind: "done", message: "Conversation forked." });
  const forked = runtime.record.sessionId;
  expect(forked).not.toBe(original);
  expect(runtime.record.forkedFrom).toBe(original);
  expect(connections[0].closed).toBe(true);
  expect(connections[1].start).toMatchObject({ sessionId: forked, resume: original, forkSession: true });
  expect(runtime.state.rows.map(row => row.uuid)).toEqual(["prompt"]);
  // A fork keeps its parent's history until Claude records the fork itself.
  connections[1].failed(new Error("Disconnected"));
  await agents.ready("workspace", id);
  expect(connections[2].start).toMatchObject({ sessionId: forked, resume: original, forkSession: true });
  record(id, forked, [{ type: "user", uuid: "prompt", timestamp: "2026-10-12T12:00:00.000Z", message: { role: "user", content: "Remember this" } }]);
  connections[2].failed(new Error("Disconnected"));
  await agents.ready("workspace", id);
  expect(connections[3].start).toMatchObject({ sessionId: forked, resume: forked });
  expect(connections[3].start.forkSession).toBeUndefined();
  expect(runtime.record.forkedFrom).toBeUndefined();
  // The Claude Code CLI's conversations stay its own.
  mkdirSync(process.env.ATELIER_DATA_DIR + "/home/.claude/projects/-work", { recursive: true });
  writeFileSync(process.env.ATELIER_DATA_DIR + "/home/.claude/projects/-work/cli.jsonl", JSON.stringify({ type: "user", uuid: "cli", timestamp: "2026-10-12T12:00:00.000Z", message: { role: "user", content: "From the CLI" } }));
  const listed = await runtime.command({ kind: "resume" }, "list");
  expect(listed).toMatchObject({ kind: "resume", current: forked });
  expect(listed.sessions.map(session => session.title)).toEqual(["Remember this", "Remember this"]);
  await runtime.command({ kind: "resume", sessionId: original }, "resume");
  expect(connections[4].start).toMatchObject({ sessionId: original, resume: original });
  await runtime.command({ kind: "new" }, "new");
  const fresh = runtime.record.sessionId;
  expect(fresh).not.toBe(original);
  expect(connections[5].start.resume).toBeUndefined();
  // Retries replay the outcome instead of switching again.
  expect(await runtime.command({ kind: "new" }, "new")).toEqual({ kind: "done", message: "New Claude Code conversation started." });
  expect(await runtime.command({ kind: "fork" }, "early-fork")).toEqual({ kind: "done", message: "Conversation forked." });
  expect(runtime.record.sessionId).toBe(fresh);
  expect(connections).toHaveLength(6);
  await expect(runtime.command({ kind: "fork" }, "new")).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(runtime.send(input, "new")).rejects.toMatchObject({ code: "invalid_arguments" });
  expect(runtime.state.rows).toEqual([]);
  connections[5].message({ type: "conversation_reset", new_conversation_id: "cleared-session", uuid: crypto.randomUUID(), session_id: "s" });
  expect(runtime.record.sessionId).toBe("cleared-session");
  await agents.disposeAll();
`));
