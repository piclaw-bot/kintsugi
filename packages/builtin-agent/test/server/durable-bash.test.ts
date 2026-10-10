import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "@kintsugi/core";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { createDurableBashExtension, type BashOperationRequest, type BashOperations } from "../../src/server/durable-bash.ts";
import { openDurableWorkspace, type DurableWorkspace } from "../../src/server/durable-workspace.ts";
import { command, localBashOperations } from "./fixtures/bash-operations.ts";

const context = BACKGROUND_CONTEXT;
const fixtures: Array<{ path: string; socket: string }> = [];
const workspaces: DurableWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()));
  for (const fixture of fixtures.splice(0)) {
    await command(["tmux", "-S", fixture.socket, "kill-server"]);
    await rm(fixture.path, { recursive: true, force: true });
  }
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "kintsugi-bash-"));
  const socket = join(path, "tmux.sock");
  await command(["tmux", "-S", socket, "new-session", "-d", "-s", "keeper"]);
  fixtures.push({ path, socket });
  const root = join(path, "receipts");
  return { path, socket, root, operations: localBashOperations(root, socket) };
}
function request(command: string, cwd: string, timeout = 10_000): BashOperationRequest {
  return { id: crypto.randomUUID(), command, cwd, deadline: Date.now() + timeout, env: {} };
}
async function finish(operations: BashOperations, input: BashOperationRequest) {
  for (let i = 0; i < 100; i++) {
    const receipt = await operations("status", input);
    if (receipt.status !== "running") return receipt;
    await Bun.sleep(50);
  }
  throw new Error("Operation did not settle");
}

// These are process/receipt protocol tests, not browser or terminal rendering tests.
test("concurrent create-or-find and response-lost retry execute exactly once and retain the result", async () => {
  const f = await fixture();
  const input = request("printf 'effect\\n' >> executions; sleep 0.2; printf 'finished\\n'", f.path);
  await Promise.all([f.operations("ensure", input, true), f.operations("ensure", input, true)]);
  const receipt = await finish(f.operations, input);
  expect(receipt).toMatchObject({ status: "done", exitCode: 0, aborted: false, timedOut: false });
  expect(await readFile(join(f.path, "executions"), "utf8")).toBe("effect\n");
  expect(await f.operations("ensure", input, false)).toEqual(receipt);
  expect(await f.operations("ensure", input, true)).toEqual(receipt);
  await expect(f.operations("ensure", { ...input, command: "different" }, true)).rejects.toThrow("different input");
});

test("missing or reserved receipts on recovery never launch a command", async () => {
  const f = await fixture();
  const input = request("touch should-not-exist", f.path);
  expect(await f.operations("ensure", input, false)).toMatchObject({ status: "uncertain" });
  await mkdir(join(f.root, input.id));
  await writeFile(join(f.root, input.id, "intent.json"), JSON.stringify(input));
  expect(await f.operations("ensure", input, true)).toMatchObject({ status: "uncertain" });
  expect(await Bun.file(join(f.path, "should-not-exist")).exists()).toBe(false);
});

test("a lost tmux supervisor is reported as uncertain rather than relaunched", async () => {
  const f = await fixture();
  const input = request("echo once >> count; sleep 10", f.path);
  await f.operations("ensure", input, true);
  for (let i = 0; i < 100 && !await Bun.file(join(f.path, "count")).exists(); i++) await Bun.sleep(10);
  expect(await readFile(join(f.path, "count"), "utf8")).toBe("once\n");
  await command(["tmux", "-S", f.socket, "kill-session", "-t", `kintsugi-agent-${input.id}`]);
  expect(await f.operations("ensure", input, true)).toMatchObject({ status: "uncertain" });
  expect(await readFile(join(f.path, "count"), "utf8")).toBe("once\n");
});

test("deadline is enforced in the workspace without host polling and is never extended on retry", async () => {
  const f = await fixture();
  const input = request("sleep 5; touch too-late", f.path, 300);
  await f.operations("ensure", input, true);
  await Bun.sleep(700);
  const receipt = await f.operations("ensure", input, false);
  expect(receipt).toMatchObject({ status: "done", timedOut: true, aborted: false });
  expect(await Bun.file(join(f.path, "too-late")).exists()).toBe(false);
});

test("Stop kills the command group, and Stop before launch fences a delayed admission", async () => {
  const f = await fixture();
  const input = request("sleep 2; touch after-stop", f.path);
  await f.operations("ensure", input, true);
  await f.operations("stop", input);
  expect(await finish(f.operations, input)).toMatchObject({ status: "done", aborted: true });
  const unlaunched = request("touch should-not-start", f.path);
  expect(await f.operations("stop", unlaunched)).toMatchObject({ status: "done", aborted: true });
  expect(await f.operations("ensure", unlaunched, true)).toMatchObject({ status: "done", aborted: true });
  await Bun.sleep(2100);
  expect(await Bun.file(join(f.path, "after-stop")).exists()).toBe(false);
  expect(await Bun.file(join(f.path, "should-not-start")).exists()).toBe(false);
});

async function harness(f: Awaited<ReturnType<typeof fixture>>, operations: BashOperations, bash: string) {
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: bash, timeout: 5 })], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  const registry = createRegistry();
  registry.install(createDurableBashExtension("workspace", operations));
  const options = { models, registry };
  const path = join(f.path, "journal");
  const workspace = await openDurableWorkspace(path, "workspace", options);
  workspaces.push(workspace);
  const conversation = await workspace.agent({ agentId: "tab", label: "Agent 1", title: "Bash recovery" }, { model: { provider: "faux", modelId: "faux-1" } });
  return { workspace, conversation, path, options };
}

test.each(["shutdown", "stop"] as const)("native Durable %s preserves or cancels the workspace process deliberately", async (action) => {
  const f = await fixture();
  let admitted!: () => void;
  const launched = new Promise<void>((resolve) => { admitted = resolve; });
  const operations: BashOperations = async (...args) => {
    const receipt = await f.operations(...args);
    if (args[0] === "ensure") admitted();
    return receipt;
  };
  const count = join(f.path, "count");
  const h = await harness(f, operations, `echo once >> ${shellQuote(count)}; sleep 1; echo finished`);
  const submission = await h.conversation.submit({ type: "input", content: "Run", requestId: "one" }, context);
  await launched;
  if (action === "stop") await h.conversation.abort(context);
  await h.workspace.close();
  const reopened = await openDurableWorkspace(h.path, "workspace", h.options);
  workspaces.push(reopened);
  const restored = (await reopened.harness.submission(submission.id, context))!;
  expect((await restored.wait(context)).status).toBe(action === "stop" ? "unanswered" : "done");
  const countText = await Bun.file(count).exists() ? await readFile(count, "utf8") : "";
  if (action === "shutdown") expect(countText).toBe("once\n");
  else expect(["", "once\n"]).toContain(countText);
  const catalog = await reopened.harness.inspect(context);
  expect(catalog.tasks).toHaveLength(0);
});


test("SIGKILL after workspace launch but before host receipt reattaches without repeating the effect", async () => {
  const f = await fixture();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/durable-bash-crash.ts"), f.path, f.socket], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("launched")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(await new Response(child.stderr).text());
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
    const expired = new Date(Date.now() - 60_000);
    await utimes(join(f.path, "journal.lock"), expired, expired);
    const models = createModels();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Recovered")]);
    const registry = createRegistry();
    registry.install(createDurableBashExtension("workspace", f.operations));
    const workspace = await openDurableWorkspace(join(f.path, "journal"), "workspace", { models, registry });
    workspaces.push(workspace);
    const inspection = await workspace.harness.inspect(context);
    expect(inspection.submissions).toHaveLength(1);
    const submission = (await workspace.harness.submission(inspection.submissions[0]!.id, context))!;
    expect((await submission.wait(context)).status).toBe("done");
    expect(await readFile(join(f.path, "count"), "utf8")).toBe("once\n");
    const conversation = await workspace.agent({ agentId: "tab", label: "Agent 1", title: "Bash recovery" });
    const entries = (await conversation.entries({}, 100, undefined, context)).items;
    const results = entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.content).toContainEqual({ type: "text", text: expect.stringContaining("recovered") });
  } finally {
    child.kill();
    await child.exited;
  }
}, 20_000);

test("a result committed while probing a dead supervisor is not reported as uncertain", async () => {
  const f = await fixture();
  const input = request("unused", f.path);
  const operation = join(f.root, input.id);
  await mkdir(operation, { recursive: true });
  await writeFile(join(operation, "intent.json"), JSON.stringify(input));
  // Deterministic process/protocol fault injection: the supervisor publishes its
  // receipt and exits exactly when the reader probes pane liveness. Exercise the
  // real receipt reader with only its subprocess transport replaced.
  const output = await command(["python3", "-c", `
import json, pathlib, runpy, subprocess, sys
script, root, request = sys.argv[1:]
operation = pathlib.Path(root) / json.loads(request)["id"]
def tmux(argv, **kwargs):
    if "display-message" in argv:
        (operation / "result.json").write_text(json.dumps({"status": "done", "aborted": True}))
        return subprocess.CompletedProcess(argv, 0, "1\\n", "")
    return subprocess.CompletedProcess(argv, 0, "", "")
subprocess.run = tmux
sys.argv = [script, "status", request, "--root", root]
runpy.run_path(script, run_name="__main__")
`, join(import.meta.dir, "../../workspace_tools/kintsugi-agent-bash"), f.root, JSON.stringify(input)]);
  expect(JSON.parse(output)).toEqual({ status: "done", aborted: true });
});

test("aborting a bash tool cancels its command group but lets the agent finish the turn", async () => {
  const f = await fixture();
  const launched = Promise.withResolvers<void>();
  let input!: BashOperationRequest;
  const operations: BashOperations = async (...args) => {
    const receipt = await f.operations(...args);
    if (args[0] === "ensure") { input = args[1]; launched.resolve(); }
    return receipt;
  };
  const h = await harness(f, operations, `sleep 3; touch ${shellQuote(join(f.path, "after-abort"))}`);
  const submission = await h.conversation.submit({ type: "input", content: "Run", requestId: "abort-tool" }, context);
  await launched.promise;
  const inspection = await h.workspace.harness.inspect(context);
  const tool = inspection.tasks.find(({ record }) => record.kind === "pi.tool")!;
  await h.workspace.harness.abortTask(tool.record.id, context);
  expect((await submission.wait(context)).status).toBe("done");
  expect(await finish(f.operations, input)).toMatchObject({ status: "done", aborted: true });
  await Bun.sleep(3100);
  expect(await Bun.file(join(f.path, "after-abort")).exists()).toBe(false);
});
