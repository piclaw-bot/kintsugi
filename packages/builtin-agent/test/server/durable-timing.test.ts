import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { durableTiming, durableTimingEntry, DurableTurnTiming } from "../../src/server/durable-timing.ts";

import { Type } from "typebox";

const context = BACKGROUND_CONTEXT;
function measure(events: Parameters<DurableTurnTiming["add"]>[0][]) {
  const timing = new DurableTurnTiming();
  for (const data of events) timing.add(data);
  return timing;
}

test("turn accounting sums inference and counts a parallel tool round only once", () => {
  const timing = measure([
    { phase: "inference-start", at: 1000 },
    { phase: "inference-end", at: 3000, outputTokens: 100, usageComplete: true, tools: true },
    { phase: "tools-end", at: 8000 },
    { phase: "inference-start", at: 8500 },
    { phase: "inference-end", at: 11500, outputTokens: 200, usageComplete: true },
  ]);
  expect(timing.summary()).toEqual({ elapsedMs: 10500, inferenceMs: 5000, toolMs: 5000, outputTokens: 300, usageComplete: true });
});

test("missing or interrupted intervals do not invent completed measurements", () => {
  expect(measure([]).summary()).toBeUndefined();
  expect(measure([{ phase: "inference-start", at: 1000 }]).summary()).toBeUndefined();
  expect(measure([
    { phase: "inference-start", at: 1000 },
    { phase: "inference-end", at: 2000, outputTokens: 10, usageComplete: true, tools: true },
  ]).summary()).toBeUndefined();
  expect(measure([
    { phase: "inference-start", at: 1000 },
    { phase: "inference-start", at: 2000 },
    { phase: "inference-end", at: 3000, outputTokens: 10, usageComplete: true },
  ]).summary()?.usageComplete).toBe(false);
});

test("native hooks persist per-response timing without a viewer or model-context pollution", async () => {
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("ping", {}), fauxToolCall("ping", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("answer"),
  ]);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test-tools", tools: [defineTool({
    name: "ping", description: "Ping", parameters: Type.Object({}), replay: "safe",
    async execute() { return { output: [{ type: "text", text: "pong" }] }; },
  })] }));
  let clock = 1000;
  registry.install(durableTiming(async (id, entry, ctx) => {
    await harness.commit(async tx => { await tx.appendEntry(durableTimingEntry, id, entry); }, ctx);
  }, () => clock += 1000));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
    await (await conversation.submit({ type: "input", content: "question", requestId: "one" }, context)).wait(context);
    const view = await conversation.context(context);
    const entries = view.entries.filter(entry => durableTimingEntry.is(entry));
    expect(entries.map(entry => entry.data.phase)).toEqual(["inference-start", "inference-end", "tools-end", "inference-start", "inference-end"]);
    expect(entries.every(entry => entry.model === undefined)).toBe(true);
    const timing = new DurableTurnTiming();
    for (const entry of entries) timing.add(entry.data);
    const outputTokens = view.messages.reduce((sum, message) => sum + (message.role === "assistant" ? message.usage.output : 0), 0);
    expect(timing.summary()).toEqual({ elapsedMs: 4000, inferenceMs: 2000, toolMs: 1000, outputTokens, usageComplete: true });
    const fork = await conversation.fork(view.entries.at(-1)!.id, { ownership: { kind: "ownerless" } }, context);
    expect((await fork.context(context)).entries.filter(entry => durableTimingEntry.is(entry))).toEqual(entries);
  } finally { await harness.close(context); }
});
