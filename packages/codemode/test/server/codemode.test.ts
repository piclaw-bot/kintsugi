import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { durableViewState, projectDurableTranscript } from "@kintsugi/builtin-agent/server";
import { openDurableAgentRuntime, type DurableAgentRuntime } from "@kintsugi/builtin-agent/server/durable-runtime";
import type { ToolView } from "@kintsugi/agent/server/transcript";
import { codemodeTool } from "./support.ts";
import { createWorkspaceCodemodeExtension } from "../../src/server/extension.ts";

const paths: string[] = [];
const runtimes: DurableAgentRuntime[] = [];
const record = { agentId: "tab", label: "Agent 1", title: "Code mode" };
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.suspend()));
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Code mode with an `echo` tool, and a `hold` tool that runs until it is cancelled, whose start `held` reports. */
async function setup() {
  const path = await mkdtemp(join(tmpdir(), "kintsugi-codemode-"));
  paths.push(path);
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  const held = Promise.withResolvers<void>();
  const registry = createRegistry();
  registry.install(createWorkspaceCodemodeExtension("native-workspace", new CodemodeSandbox()));
  registry.install(defineExtension({ name: "codemode-test-tools", tools: [
    defineTool({
      name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }),
      async execute(args) { return { output: [{ type: "text", text: args.text }] }; },
    }),
    defineTool({
      name: "hold", description: "Hold until cancelled", parameters: Type.Object({}),
      async execute(_args, _api, invocation) {
        held.resolve();
        return await new Promise<never>((_resolve, reject) => invocation.abortSignal!.addEventListener("abort", () => reject(invocation.abortSignal!.reason), { once: true }));
      },
    }),
  ] }));
  const runtime = await openDurableAgentRuntime(path, "native-workspace", {}, {
    harness: async () => ({ models, registry }),
    prepare: async () => ({ model: { provider: "faux", modelId: "faux-1" }, instructions: "Committed instructions", thinkingLevel: "off" }),
    expand: async (_workspace, text) => text, validateModel: async () => {}, ready: async () => {},
  });
  runtimes.push(runtime);
  return { runtime, faux, held, agent: await runtime.agent(record) };
}

type Agent = Awaited<ReturnType<DurableAgentRuntime["agent"]>>;

async function scriptTool(agent: Agent): Promise<ToolView | undefined> {
  const watch = await agent.watch(context);
  const tool = codemodeTool(projectDurableTranscript(watch.value));
  await watch.stop();
  return tool;
}

/** Wait until the running tool's committed output, which a stop keeps, contains `text`. */
async function committedOutput(agent: Agent, text: string) {
  for (;;) {
    const watch = await agent.watch(context);
    const output = durableViewState(watch.value).live.tools?.[0]?.output;
    await watch.stop();
    if (output?.includes(text)) return;
    await Bun.sleep(20);
  }
}

test("code mode records each call a script makes, with its arguments and result", async () => {
  const { faux, agent } = await setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: "return await tools.echo({ text: 'echoed' });" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  expect((await (await agent.submit({ requestId: "script", text: "Run it" })).wait(context)).status).toBe("done");
  const [echo] = (await scriptTool(agent))!.nested!;
  expect(echo).toMatchObject({ name: "echo", args: { text: "echoed" }, status: "ok", resultText: "echoed" });
});

test("a stopped script keeps the calls it made, for the transcript and the model", async () => {
  const { faux, agent, held } = await setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: "await tools.echo({ text: 'before the stop' }); await tools.hold({});" })], { stopReason: "toolUse" }),
  ]);
  await agent.submit({ requestId: "script", text: "Run it" });
  await held.promise;
  await committedOutput(agent, "started c2");
  await agent.stop();
  const tool = (await scriptTool(agent))!;
  const [echo, hold] = tool.nested!;
  expect(echo).toMatchObject({ name: "echo", status: "ok", resultText: "before the stop" });
  expect(hold).toMatchObject({ name: "hold", status: "error", details: { aborted: true } });
  // What the model gets for the stopped script: which calls ran, and which one the stop cut off.
  expect(tool.resultText).toContain('started c1: echo {"text":"before the stop"}\nfinished c1: ok\nstarted c2: hold {}');
  expect(tool.resultText).not.toContain("finished c2");
});
