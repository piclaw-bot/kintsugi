import { expect, test } from "bun:test";
import { CodexRpc } from "../src/server/rpc.ts";
import type { CodexNotification } from "../src/server/protocol.ts";

test("app-server replies correlate by ID rather than arrival order", async () => {
  const writes: string[] = [];
  const rpc = new CodexRpc(line => writes.push(line), () => {});
  const first = rpc.request("initialize", { clientInfo: { name: "test", title: null, version: "1" }, capabilities: null });
  const second = rpc.request("turn/interrupt", { threadId: "thread", turnId: "turn" });
  expect(writes.map(line => JSON.parse(line).id)).toEqual([1, 2]);
  rpc.receive(JSON.stringify({ id: 2, result: {} }));
  const initialized = { userAgent: "test", codexHome: "/codex", platformFamily: "unix", platformOs: "linux" };
  rpc.receive(JSON.stringify({ id: 1, result: initialized }));
  expect(await first).toEqual(initialized);
  expect(await second).toEqual({});
});

test("provider and transport failures reject pending operations", async () => {
  const rpc = new CodexRpc(() => {}, () => {});
  const rejected = rpc.request("turn/interrupt", { threadId: "t", turnId: "a" });
  rpc.receive(JSON.stringify({ id: 1, error: { code: -32000, message: "Turn already ended" } }));
  await expect(rejected).rejects.toThrow("Turn already ended");
  const pending = rpc.request("turn/interrupt", { threadId: "t", turnId: "b" });
  rpc.fail(new Error("Disconnected"));
  await expect(pending).rejects.toThrow("Disconnected");
  await expect(rpc.request("turn/interrupt", { threadId: "t", turnId: "c" })).rejects.toThrow("Disconnected");
});

test("unsupported interactive requests receive an error instead of hanging Codex", () => {
  const writes: string[] = [];
  const notifications: CodexNotification[] = [];
  const rpc = new CodexRpc(line => writes.push(line), notification => notifications.push(notification));
  rpc.receive(JSON.stringify({ id: "question-1", method: "item/tool/requestUserInput", params: {} }));
  expect(JSON.parse(writes[0]!)).toEqual({ id: "question-1", error: { code: -32601, message: "Kintsugi does not support item/tool/requestUserInput yet" } });
  expect(notifications).toEqual([{ method: "client/unsupportedRequest", params: { method: "item/tool/requestUserInput" } }]);
});

test("invalid envelopes fail loudly while unrelated notifications are ignored", () => {
  const rpc = new CodexRpc(() => {}, () => {});
  expect(() => rpc.receive("not json")).toThrow();
  expect(() => rpc.receive("[]")).toThrow("Invalid Codex RPC message");
  expect(() => rpc.receive('{"id":12,"result":{}}')).toThrow("Unknown Codex RPC response");
  expect(() => rpc.receive('{"method":"account/updated","params":{}}')).not.toThrow();
});
