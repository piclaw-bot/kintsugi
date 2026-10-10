import { expect, test } from "bun:test";
import type { JsonObject } from "@kintsugi/core";
import type { Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

const model: Model<"openai-responses"> = {
  id: "gpt-6.1-sol", name: "Phase fixture", provider: "openai", api: "openai-responses",
  baseUrl: "https://never-contact.invalid/v1", reasoning: false, input: ["text"],
  contextWindow: 10000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

for (const phase of ["final_answer", "commentary", undefined] as const) {
  test(`OpenAI preserves ${phase ?? "unphased"} stop reason before text starts`, async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    function send(event: JsonObject) {
      source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    }
    const events = stream(model, normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] }), {
      apiKey: "sk-test",
      fetch: Object.assign(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }), { preconnect: fetch.preconnect }),
    });
    const iterator = events[Symbol.asyncIterator]();
    send({ type: "response.output_item.added", output_index: 0,
      item: { type: "message", id: "msg-1", role: "assistant", status: "in_progress", phase: phase ?? null, content: [] } });
    expect((await iterator.next()).value?.type).toBe("start");
    const start = (await iterator.next()).value;
    expect(start?.type).toBe("text_start");
    if (start?.type !== "text_start") throw new Error("Expected text_start");
    const part = start.partial.content[start.contentIndex]!;
    if (part.type !== "text") throw new Error("Expected text content");
    expect(part.text).toBe("");
    expect(start.partial.stopReason).toBe(phase === "final_answer" ? "stop" : "pending");

    send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" });
    const delta = (await iterator.next()).value;
    expect(delta?.type).toBe("text_delta");
    expect(part.text).toBe("Hello");
    expect(start.partial.stopReason).toBe(phase === "final_answer" ? "stop" : "pending");

    send({ type: "response.output_item.done", output_index: 0,
      item: { type: "message", id: "msg-1", role: "assistant", status: "completed", phase: phase ?? null,
        content: [{ type: "output_text", text: "Hello", annotations: [] }] } });
    expect((await iterator.next()).value?.type).toBe("text_end");
    send({ type: "response.completed", response: { id: "resp-1", status: "completed", output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    source.close();
    const result = await events.result();
    expect(result.stopReason).toBe("stop");
    const signature = phase ? { v: 1, id: "msg-1", phase } : { v: 1, id: "msg-1" };
    expect(result.content).toEqual([{ type: "text", text: "Hello", textSignature: JSON.stringify(signature) }]);
  });
}
