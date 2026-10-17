import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isJsonObject } from "@kintsugi/core";
import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createPiModelRuntime } from "../../src/server/pi-config-models.ts";
import { parseTelemetryConfig, graphiteSegment, metricPoints, counterDelta, type TelemetryConfig, type TelemetryCounter, type TokenUsage } from "../../src/server/token-telemetry-types.ts";
import { TokenTelemetryStore, maxTelemetrySpoolAgeMs, maxTelemetrySpoolBytes } from "../../src/server/token-telemetry-store.ts";
import { baselineNativeUsage, collectNativeUsage, nativeUsageRecords, discoverNativeUsageFiles, type NativeUsageState } from "../../src/server/token-telemetry-native.ts";
import { TokenTelemetry, sendCarbon, estimateTelemetryCost } from "../../src/server/token-telemetry.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), "kintsugi-telemetry-")); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir; }
const config: TelemetryConfig = { enabled: true, host: "127.0.0.1", port: 2003, instance: "My_Kintsugi", intervalMinutes: 15 };
const usage: TokenUsage = { input: 10, output: 5, cache_read: 20, cache_write: 3, reasoning: 2, total: 38, cost: 0.01 };
const counter = (total: number): TelemetryCounter => ({ id: "conversation:models:provider/model", provider: "provider", model: "model", usage: { input: total, output: 0, total } });
async function storeFixture() { const dir = await directory(), path = join(dir, "telemetry/usage.sqlite"), store = new TokenTelemetryStore(path); cleanup.push(async () => store.close()); return { dir, path, store }; }
const state = (): NativeUsageState => ({ model: "unknown", session: "", turn: "" });
const cutoff = Date.parse("2026-10-17T10:00:00Z");
const at = "2026-10-17T10:01:00Z";
const noopEstimate = () => {};
async function history(dir: string, suffix: string, rows: object[]) { const file = join(dir, suffix); await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, rows.map(row => JSON.stringify(row) + "\n").join("")); return file; }
const piRow = (id: string, timestamp = at) => ({ type: "message", id, timestamp, message: { role: "assistant", provider: "provider", model: "model", usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3, reasoning: 2, totalTokens: 38, cost: { total: 0.01 } } } });
const claudeRow = (id: string, timestamp = at, output = 5) => ({ type: "assistant", uuid: id + "-block", timestamp, message: { id, model: "claude-test", usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } } });
const codexRow = (total: number, timestamp = at) => ({ type: "event_msg", timestamp, payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, output_tokens: total / 2, cached_input_tokens: total / 2, reasoning_output_tokens: total / 10, total_tokens: total * 1.5 }, last_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 5, reasoning_output_tokens: 1, total_tokens: 15 } } } });

test("validates settings and uses PiClaw-compatible path normalisation", () => {
  expect(graphiteSegment(" GPT-5.4 / mini ")).toBe("gpt-5_4_mini");
  expect(parseTelemetryConfig(config).instance).toBe("my_kintsugi");
  for (const bad of [{ ...config, port: 0 }, { ...config, port: 65536 }, { ...config, intervalMinutes: 0 }, { ...config, intervalMinutes: 61 }, { ...config, host: "tcp://host:2003" }, { ...config, host: "host\nsecret" }, { ...config, instance: "..." }, { ...config, enabled: "yes" }, { ...config, host: "" }]) expect(() => parseTelemetryConfig(bad)).toThrow();
});

test("exports interval sums, optional counters and estimated USD without counting reasoning twice", () => {
  const points = metricPoints(config, [{ provider: "GitHub-Copilot", model: "GPT-5.4", usage }, { provider: "github-copilot", model: "gpt.5.4", usage }], 100);
  expect(points.find(point => point.path.endsWith("tokens.total"))).toEqual({ path: "kintsugi.my_kintsugi.usage.github-copilot.gpt-5_4.tokens.total", value: 38, timestamp: 100 });
  const minimal = metricPoints(config, [{ provider: "x", model: "x", usage: { input: 1, output: 2, total: 3 } }], 100);
  expect(minimal.map(point => point.path.split(".").at(-1))).toEqual(["input", "output", "total"]);
  expect(metricPoints(config, [{ provider: "x", model: "x", usage: { input: 1, output: 2, total: 3, cost: 0 } }], 100).at(-1)!.value).toBe(0);
  expect(counterDelta(usage, usage).total).toBe(0);
});

test("cache percentages are weighted by prompt tokens and unavailable coverage never becomes zero", () => {
  const records = [
    { provider: "p", model: "m", usage: { input: 1, output: 2, cache_read: 9, cache_write: 0, total: 12 } },
    { provider: "p", model: "m", usage: { input: 90, output: 5, cache_read: 0, cache_write: 0, total: 95 } },
  ];
  const points = metricPoints(config, records, 100);
  expect(points.find(point => point.path.endsWith("cache.hit_percent"))!.value).toBe(9);
  expect(points.find(point => point.path.endsWith("tokens.prompt"))!.value).toBe(100);
  const unknown = metricPoints(config, [records[0]!, { provider: "p", model: "m", usage: { input: 90, output: 5, total: 95 } }], 100);
  expect(unknown.some(point => point.path.endsWith("cache.hit_percent"))).toBe(false);
  expect(unknown.some(point => point.path.endsWith("tokens.prompt"))).toBe(false);
  const empty = metricPoints(config, [{ provider: "p", model: "m", usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } }], 100);
  expect(empty.some(point => point.path.endsWith("cache.hit_percent"))).toBe(false);
});

test("Pi and Claude adapters deduplicate by invocation identity, not branch or content block", () => {
  const a = nativeUsageRecords("claude", claudeRow("msg"), state(), cutoff, "one");
  const b = nativeUsageRecords("claude", { ...claudeRow("msg"), uuid: "second-block" }, state(), cutoff, "copy");
  expect(a[0]!.id).toBe(b[0]!.id);
  expect(a[0]!.usage).toMatchObject({ input: 10, output: 5, total: 38 });
  expect(a[0]!.usage.cost).toBeUndefined();
  expect(nativeUsageRecords("pi", piRow("entry"), state(), cutoff, "one")[0]!.usage).toEqual(usage);
  expect(nativeUsageRecords("pi", piRow("entry", "2026-01-01T00:00:00Z"), state(), cutoff, "one")).toEqual([]);
  expect(nativeUsageRecords("claude", { ...claudeRow("bad"), isApiErrorMessage: true }, state(), cutoff, "one")[0]!.usage.total).toBe(38);
});

test("Codex cumulative snapshots become call deltas; cached input and reasoning are subsets", () => {
  const meta = state();
  nativeUsageRecords("codex", { type: "session_meta", payload: { id: "thread" } }, meta, cutoff, "file");
  nativeUsageRecords("codex", { type: "turn_context", payload: { model: "gpt-test", turn_id: "turn" } }, meta, cutoff, "file");
  nativeUsageRecords("codex", codexRow(100, "2026-01-01T00:00:00Z"), meta, cutoff, "file");
  const a = nativeUsageRecords("codex", codexRow(110), meta, cutoff, "file")[0]!;
  expect(a.model).toBe("gpt-test"); expect(a.usage).toMatchObject({ input: 5, cache_read: 5, output: 5, reasoning: 1, total: 15 });
  expect(nativeUsageRecords("codex", codexRow(110), meta, cutoff, "file")[0]!.usage.total).toBe(0);
  expect(nativeUsageRecords("codex", codexRow(120), meta, cutoff, "file")[0]!.usage.total).toBe(15);
});

test("rejects malformed native counts and omits unknown cost instead of making it zero", async () => {
  const row = piRow("bad"); row.message.usage.input = -1;
  expect(nativeUsageRecords("pi", row, state(), cutoff, "file")).toEqual([]);
  const record = { id: "x", provider: "missing", model: "missing", usage: { input: 1, output: 2, total: 3 } };
  estimateTelemetryCost(record, undefined); expect("cost" in record.usage).toBe(false);
  const known = { id: "x", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 1000, output: 100, cache_read: 0, cache_write: 0, total: 1100 } };
  estimateTelemetryCost(known, (await createPiModelRuntime()).getModel("anthropic", "claude-sonnet-4-5"));
  expect(Value.Check(Type.Object({ cost: Type.Number({ exclusiveMinimum: 0 }) }), known.usage)).toBe(true);
});


test("persistent aggregation omits unavailable counters and costs, including explicitly undefined native fields", async () => {
  const { store } = await storeFixture();
  store.event({ id: "unknown", provider: "provider", model: "unknown", usage: { input: 1, output: 2, total: 3, cost: undefined, reasoning: undefined, cache_read: undefined } });
  store.batch(config, cutoff);
  const payload = store.nextBatch()!.payload;
  expect(payload).not.toContain("cost.estimated_usd"); expect(payload).not.toContain("tokens.reasoning"); expect(payload).not.toContain("tokens.cache_read");
  expect(payload).toContain(".tokens.total 3 ");
});

test("persistent interval aggregation preserves incomplete cache coverage", async () => {
  const { store } = await storeFixture();
  store.event({ id: "cached", provider: "p", model: "m", usage: { input: 1, output: 2, cache_read: 9, cache_write: 0, total: 12 } });
  store.event({ id: "unknown", provider: "p", model: "m", usage: { input: 90, output: 5, total: 95 } });
  store.batch(config, cutoff);
  const payload = store.nextBatch()!.payload;
  expect(payload).toContain(".tokens.cache_read 9 ");
  expect(payload).not.toContain("cache.hit_percent"); expect(payload).not.toContain("tokens.prompt");
});

test("stores deltas and cursors atomically and preserves deduplication across restart", async () => {
  const dir = await directory(), path = join(dir, "telemetry/usage.sqlite");
  let store = new TokenTelemetryStore(path);
  store.counter("source", counter(100), true);
  store.transaction(() => { store.counter("source", counter(110)); store.event({ id: "call", provider: "provider", model: "model", usage }); });
  store.batch(config, cutoff);
  const payload = store.nextBatch()!.payload;
  expect(payload).toContain(".tokens.total 48 ");
  expect(() => store.transaction(() => { store.event({ id: "rollback", provider: "x", model: "x", usage }); throw new Error("crash"); })).toThrow();
  store.close(); store = new TokenTelemetryStore(path);
  try {
    store.counter("source", counter(110)); store.event({ id: "call", provider: "provider", model: "model", usage });
    expect(store.pending()).toBe(0); expect(store.nextBatch()!.payload).toBe(payload);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally { store.close(); }
});

test("Claude blocks with growing usage add only positive increments and cannot lower the replay baseline", async () => {
  const { store } = await storeFixture();
  for (const output of [5, 5, 8, 2, 8]) store.event(nativeUsageRecords("claude", claudeRow("shared", at, output), state(), cutoff, "one")[0]!);
  store.batch(config, cutoff);
  expect(store.nextBatch()!.payload).toContain(".tokens.output 8 ");
  expect(store.nextBatch()!.payload).toContain(".tokens.total 41 ");
});

test("bounds the retry spool by age and bytes and records dropped batches", async () => {
  const { store } = await storeFixture();
  store.event({ id: "old", provider: "x", model: "x", usage }); store.batch(config, 1);
  store.trim(maxTelemetrySpoolAgeMs + 2); expect(store.queued()).toBe(0); expect(store.state("droppedBatches")).toBe("1");
  store.db.query("INSERT INTO batches(created,payload) VALUES (?,?)").run(cutoff, "x".repeat(maxTelemetrySpoolBytes + 1));
  store.trim(cutoff); expect(store.queued()).toBe(0); expect(store.state("droppedBatches")).toBe("2");
});

test("discovers every backend's canonical files, including subagents, without reading session-share copies or symlinks", async () => {
  const dir = await directory();
  const suffixes = ["home/.claude/projects/-work/s.jsonl", "home/.claude/projects/-work/s/subagents/agent-a.jsonl", "home/.codex/sessions/2026/a.jsonl", "workspaces/ws/home-local/.local/share/kintsugi-agents/agent/claude/projects/-work/a.jsonl", "workspaces/ws/home-local/.local/share/kintsugi-agents/agent/codex/sessions/a.jsonl", "workspaces/ws/home-local/.local/share/pi/sessions/agent/a.jsonl"];
  for (const suffix of suffixes) await history(dir, suffix, []);
  const copy = await history(dir, "session-shares/projectless/export.jsonl", []);
  await symlink(copy, join(dir, "home/.claude/projects/-work/link.jsonl"));
  expect((await discoverNativeUsageFiles(dir)).map(file => file.path).sort()).toEqual(suffixes.map(path => join(dir, path)).sort());
});

test("enabling skips history, seeds Codex counters and tails new usage after process restart", async () => {
  const { dir, store } = await storeFixture();
  const pi = await history(dir, "workspaces/ws/home-local/.local/share/pi/sessions/tab/a.jsonl", [piRow("old")]);
  const codex = await history(dir, "home/.codex/sessions/a.jsonl", [{ type: "turn_context", payload: { model: "gpt-test" } }, codexRow(100)]);
  await baselineNativeUsage(dir, store);
  await appendFile(pi, JSON.stringify(piRow("new")) + "\n"); await appendFile(codex, JSON.stringify(codexRow(110)) + "\n");
  await collectNativeUsage(dir, store, cutoff, noopEstimate);
  store.batch(config, cutoff);
  expect(store.nextBatch()!.payload).toContain(".provider.model.tokens.total 38 ");
  expect(store.nextBatch()!.payload).toContain(".openai-codex.gpt-test.tokens.total 15 ");
  await collectNativeUsage(dir, store, cutoff, noopEstimate); expect(store.pending()).toBe(0);
});

test("waits for complete JSONL rows and survives rotation, truncation and copied history", async () => {
  const { dir, store } = await storeFixture();
  const path = await history(dir, "home/.claude/projects/-work/a.jsonl", []);
  await baselineNativeUsage(dir, store);
  const line = JSON.stringify(claudeRow("one")); await appendFile(path, line.slice(0, 20));
  await collectNativeUsage(dir, store, cutoff, noopEstimate); expect(store.pending()).toBe(0);
  await appendFile(path, line.slice(20) + "\n"); await collectNativeUsage(dir, store, cutoff, noopEstimate); store.batch(config, cutoff);
  await rename(path, path + ".old"); await writeFile(path, line + "\n" + JSON.stringify(claudeRow("two")) + "\n");
  await collectNativeUsage(dir, store, cutoff, noopEstimate); store.batch(config, cutoff + 1000);
  expect(store.queued()).toBe(2);
  store.delivered(store.nextBatch()!.id, cutoff); expect(store.nextBatch()!.payload).toContain(".tokens.total 38 ");
});

test("skips oversized rows with diagnostics and processes the following valid record", async () => {
  const { dir, store } = await storeFixture();
  const path = await history(dir, "home/.claude/projects/-work/a.jsonl", []);
  await baselineNativeUsage(dir, store);
  await appendFile(path, "x".repeat(6 * 1024 * 1024) + "\n" + JSON.stringify(claudeRow("after")) + "\n");
  for (let i = 0; i < 4; i++) await collectNativeUsage(dir, store, cutoff, noopEstimate);
  expect(Number(store.state("oversizedRows"))).toBe(1); expect(store.pending()).toBe(1);
});

test("disabled exporter creates no database and runtime snapshots use new-only baselines", async () => {
  const dir = await directory(); let now = cutoff;
  const sent: string[] = [], service = new TokenTelemetry(dir, () => now, async (_host, _port, payload = "") => { sent.push(payload); }); cleanup.push(() => service.close());
  await service.start(); expect(await Bun.file(join(dir, "telemetry/usage.sqlite")).exists()).toBe(false);
  let current = 100;
  const stop = await service.register({ id: "journal", read: async () => [counter(current)] });
  await service.configure(config); current = 110;
  await service.collect(); await service.flush(); expect(sent).toEqual([]);
  now += 15 * 60_000; await service.flush(); expect(sent[0]).toContain(".tokens.total 10 ");
  current = 120; await stop(); await service.flush(true); expect(sent[1]).toContain(".tokens.total 10 ");
  expect((await stat(join(dir, "telemetry/config.json"))).mode & 0o777).toBe(0o600);
});

test("delivery failure persists an identical batch, refuses destination changes and excludes disabled periods", async () => {
  const dir = await directory(); let now = cutoff, fail = true, count = 0;
  const payloads: string[] = [], service = new TokenTelemetry(dir, () => now, async (_host, _port, payload = "") => { payloads.push(payload); if (fail) throw new Error("offline"); }); cleanup.push(() => service.close());
  await service.register({ id: "journal", read: async () => [counter(count)] }); await service.configure(config);
  count = 10; await service.collect(); now += 60_000;
  await expect(service.flush(true)).rejects.toThrow("offline"); expect((await service.status()).queuedBatches).toBe(1);
  await expect(service.configure({ ...config, host: "other" })).rejects.toThrow("Pending exports");
  await service.configure({ ...config, enabled: false }); count = 100; await service.collect();
  await service.configure(config); count = 105; now += 60_000; await service.collect(); fail = false;
  await service.flush(true); expect(payloads[1]!.startsWith(payloads[0]!)).toBe(true);
  expect(payloads[1]).toContain(".tokens.total 5 ");
  expect((await service.status()).queuedBatches).toBe(0);
});

test("new-only counters resume from durable checkpoints without recounting history", async () => {
  const dir = await directory(); let count = 100;
  const source = { id: "journal", read: async () => [counter(count)] };
  const first = new TokenTelemetry(dir, () => cutoff, async () => {});
  await first.register(source); await first.configure(config); count = 110; await first.collect(); await first.close();
  const sent: string[] = [], second = new TokenTelemetry(dir, () => cutoff + 60_000, async (_host, _port, payload = "") => { sent.push(payload); }); cleanup.push(() => second.close());
  await second.start(); await second.register(source); count = 120; await second.collect(); await second.flush(true);
  expect(sent[0]).toContain(".tokens.total 20 ");
});

test("test connection sends no usage, and Carbon transport writes newline-terminated plaintext", async () => {
  const chunks: string[] = [];
  const server = createServer(socket => socket.on("data", data => chunks.push(data.toString())));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || Value.Check(Type.String(), address)) throw new Error("No TCP fixture port");
  try {
    await sendCarbon("127.0.0.1", address.port);
    expect(chunks).toEqual([]);
    const payload = "kintsugi.test.usage.provider.model.tokens.total 42 123\n";
    await sendCarbon("127.0.0.1", address.port, payload); expect(chunks.join("")).toBe(payload);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("Claude recovers session identity for partial usage records and lets response models override it", () => {
  const meta = state();
  nativeUsageRecords("claude", { type: "system", subtype: "init", model: "claude-session" }, meta, cutoff, "file");
  const { model: _model, ...message } = claudeRow("partial").message;
  expect(nativeUsageRecords("claude", { ...claudeRow("partial"), message }, meta, cutoff, "file")[0]!.model).toBe("claude-session");
  expect(nativeUsageRecords("claude", claudeRow("concrete"), meta, cutoff, "file")[0]!.model).toBe("claude-test");
});

test("Codex keeps explicit native provider identity and separates model changes without changing cache counts", () => {
  const meta = state();
  nativeUsageRecords("codex", { type: "session_meta", payload: { id: "thread", model_provider: "private-provider" } }, meta, cutoff, "file");
  nativeUsageRecords("codex", { type: "turn_context", payload: { model: "model-one", turn_id: "one" } }, meta, cutoff, "file");
  const first = nativeUsageRecords("codex", codexRow(100), meta, cutoff, "file")[0]!;
  expect(first).toMatchObject({ provider: "private-provider", model: "model-one", usage: { input: 5, output: 5, cache_read: 5, total: 15 } });
  expect(metricPoints(config, [first], 100).find(point => point.path.endsWith("cache.hit_percent"))!.value).toBe(50);
  nativeUsageRecords("codex", { type: "turn_context", payload: { model: "model-two", turn_id: "two" } }, meta, cutoff, "file");
  expect(nativeUsageRecords("codex", codexRow(110), meta, cutoff, "file")[0]).toMatchObject({ provider: "private-provider", model: "model-two", usage: { total: 15 } });
  nativeUsageRecords("codex", { type: "session_meta", payload: { id: "another-thread", model_provider: "openai" } }, meta, cutoff, "file");
  nativeUsageRecords("codex", { type: "turn_context", payload: { model: "fresh" } }, meta, cutoff, "file");
  expect(nativeUsageRecords("codex", codexRow(10), meta, cutoff, "file")[0]).toMatchObject({ provider: "openai-codex", model: "fresh", usage: { total: 15 } });
});

test("Pi recovers identity from the correct branch instead of a sibling's last model", () => {
  const meta = state();
  nativeUsageRecords("pi", { type: "model_change", id: "model-a", parentId: null, provider: "provider-a", modelId: "model-a" }, meta, cutoff, "file");
  nativeUsageRecords("pi", { type: "message", id: "user", parentId: "model-a", message: { role: "user" } }, meta, cutoff, "file");
  nativeUsageRecords("pi", { type: "model_change", id: "sibling", parentId: "user", provider: "provider-b", modelId: "model-b" }, meta, cutoff, "file");
  const { provider: _provider, model: _model, ...message } = piRow("recovered").message;
  const recovered = nativeUsageRecords("pi", { ...piRow("recovered"), parentId: "user", message }, meta, cutoff, "file")[0]!;
  expect(recovered).toMatchObject({ provider: "provider-a", model: "model-a", usage });
  const points = metricPoints(config, [recovered], 100);
  expect(points.find(point => point.path.endsWith("tokens.prompt"))!.value).toBe(33);
  expect(points.find(point => point.path.endsWith("cache.hit_percent"))!.value).toBeCloseTo(20 / 33 * 100);
  const unresolved = nativeUsageRecords("pi", { ...piRow("missing-parent"), parentId: "unavailable-ancestor", message }, meta, cutoff, "file")[0]!;
  expect(unresolved.provider).toBe("unknown"); expect(unresolved.model).toBe("unknown");
});

test("Pi physical response models and standalone usage keep their own identity, including cache warming", () => {
  const meta = state();
  const response = nativeUsageRecords("pi", { ...piRow("physical"), message: { ...piRow("physical").message, model: "virtual-selection", responseModel: "physical-response" } }, meta, cutoff, "file")[0]!;
  expect(response.model).toBe("physical-response");
  const warm = { type: "usage", id: "warming", parentId: "physical", timestamp: at, kind: "cache_warm", provider: "warm-provider", model: "warm-model", usage: piRow("unused").message.usage };
  expect(nativeUsageRecords("pi", warm, meta, cutoff, "file")[0]).toMatchObject({ provider: "warm-provider", model: "warm-model", usage });
  const { provider: _provider, model: _model, ...message } = piRow("continuation").message;
  expect(nativeUsageRecords("pi", { ...piRow("continuation"), parentId: "warming", message }, meta, cutoff, "file")[0]).toMatchObject({ provider: "provider", model: "physical-response" });
  expect(meta.piContexts!.length).toBeLessThanOrEqual(128);
});

test("native metadata recovered at enablement survives cursor persistence without backfilling usage", async () => {
  const { dir, store } = await storeFixture();
  const claude = await history(dir, "home/.claude/projects/-work/partial.jsonl", [claudeRow("old")]);
  const pi = await history(dir, "workspaces/ws/home-local/.local/share/pi/sessions/tab/partial.jsonl", [
    { type: "model_change", id: "model", parentId: null, provider: "selected-provider", modelId: "selected-model" },
    { type: "message", id: "user", parentId: "model", message: { role: "user" } },
  ]);
  await baselineNativeUsage(dir, store);
  const { model: _model, ...claudeMessage } = claudeRow("new").message;
  const { provider: _provider, model: _piModel, ...piMessage } = piRow("new").message;
  await appendFile(claude, JSON.stringify({ ...claudeRow("new"), message: claudeMessage }) + "\n");
  await appendFile(pi, JSON.stringify({ ...piRow("new"), parentId: "user", message: piMessage }) + "\n");
  await collectNativeUsage(dir, store, cutoff, noopEstimate); store.batch(config, cutoff);
  const payload = store.nextBatch()!.payload;
  expect(payload).toContain(".anthropic.claude-test.tokens.total 38 ");
  expect(payload).toContain(".selected-provider.selected-model.tokens.total 38 ");
  expect(payload).not.toContain("unknown");
  await collectNativeUsage(dir, store, cutoff, noopEstimate); expect(store.pending()).toBe(0);
});


test("actual Pi SessionManager usage entries export their recorded models and cache counts", async () => {
  const dir = await directory(), manager = SessionManager.create("/work", join(dir, "native"));
  const nativeUsage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 3, reasoning: 2, totalTokens: 38, cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 } };
  manager.appendModelChange("chat-provider", "chat-model");
  manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "chat-provider", model: "chat-model", content: [{ type: "text", text: "Recorded response" }], stopReason: "stop", usage: nativeUsage, timestamp: cutoff + 1000 });
  const warm = manager.appendUsage("cache_warm", "warm-provider", "warm-model", nativeUsage);
  const rows = (await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n");
  const meta = state(), records = rows.flatMap(line => { const row: unknown = JSON.parse(line); return isJsonObject(row) ? nativeUsageRecords("pi", row, meta, cutoff, "file") : []; });
  expect(records.some(record => record.model === "chat-model")).toBe(true);
  expect(records.some(record => record.provider === warm.provider && record.model === warm.model)).toBe(true);
  const points = metricPoints(config, records, 100);
  expect(points.find(point => point.path.endsWith("warm-provider.warm-model.tokens.cache_read"))!.value).toBe(20);
  expect(points.find(point => point.path.endsWith("warm-provider.warm-model.cache.hit_percent"))!.value).toBeCloseTo(20 / 33 * 100);
});


test("enabling Codex export preserves custom provider identity when the header is outside the bounded tail", async () => {
  const { dir, store } = await storeFixture();
  const path = await history(dir, "home/.codex/sessions/large.jsonl", [
    { type: "session_meta", payload: { id: "private-thread", model_provider: "private-provider", model: "old-model" } },
    ...Array.from({ length: 40 }, () => ({ type: "unrelated", payload: { type: "unrelated", text: "x".repeat(64 * 1024) } })),
    { type: "turn_context", payload: { model: "recent-model", turn_id: "recent-turn" } }, codexRow(100),
  ]);
  await baselineNativeUsage(dir, store);
  await appendFile(path, JSON.stringify(codexRow(110)) + "\n");
  await collectNativeUsage(dir, store, cutoff, noopEstimate); store.batch(config, cutoff);
  expect(store.nextBatch()!.payload).toContain(".private-provider.recent-model.tokens.total 15 ");
  expect(store.nextBatch()!.payload).not.toContain("openai-codex");
});

test("recording usage does not mutate caller-owned usage or snapshot objects", async () => {
  const { store } = await storeFixture();
  const record = { id: "immutable", provider: "p", model: "m", usage: { input: 1, output: 2, total: 3 } };
  const before = structuredClone(record);
  store.event(record); store.counter("source", record, true); store.counter("source", record);
  expect(record).toEqual(before); expect(Object.hasOwn(record.usage, "cache_complete")).toBe(false);
});
