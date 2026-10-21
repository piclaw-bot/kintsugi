import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeWorkerAdmission } from "../../src/server/codemode-worker-admission.ts";

const context = BACKGROUND_CONTEXT;

test("native code mode admission counts reservations until the worker-exit release", () => {
  const acquire = createCodemodeWorkerAdmission(2), first = acquire(), second = acquire();
  expect(() => acquire()).toThrow("2-worker limit");
  first(); const third = acquire(); expect(() => acquire()).toThrow("2-worker limit");
  second(); third(); const next = acquire(); next();
});

test("Pi 1.3 releases native code mode capacity on actual worker exit", async () => {
  const acquire = createCodemodeWorkerAdmission(1), exits: Promise<void>[] = [];
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 32 * 1024 * 1024, acquireWorker: acquire, onWorkerStarted: exited => { exits.push(exited); } });
  try {
    expect((await sandbox.execute('text("local worker");')).ok).toBe(true);
    await exits[0];
    const release = acquire(); release();
    expect((await sandbox.execute('text("capacity restored");')).ok).toBe(true);
    await exits[1];
    const last = acquire(); last();
  } finally { await sandbox.close(); }
});

test("cancelled code mode keeps its reservation until the worker actually exits", async () => {
  const acquire = createCodemodeWorkerAdmission(1), started = Promise.withResolvers<void>(), exits: Promise<void>[] = [];
  const abort = new AbortController();
  const sandbox = new CodemodeSandbox({ acquireWorker: acquire, onWorkerStarted: exited => { exits.push(exited); }, tools: [{ name: "hold", execute: () => {
    started.resolve(); return new Promise<never>(() => {});
  } }] });
  try {
    const running = sandbox.execute("await tools.hold({});", { signal: abort.signal });
    await started.promise;
    expect(() => acquire()).toThrow("1-worker limit");
    abort.abort();
    const result = await running;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected cancelled execution");
    expect(result.error.kind).toBe("aborted");
    await exits[0];
    const release = acquire(); release();
  } finally { abort.abort(); await sandbox.close(); }
});

class CountingStorage extends MemoryStorage {
  documentReads = 0;
  override document(...args: Parameters<MemoryStorage["document"]>) { this.documentReads++; return super.document(...args); }
}

test("Pi 1.3 evicts unused document caches and reloads committed values without losing watched state", async () => {
  const state = defineDoc<{ count: number }>({ kind: "test.pi13-cache", version: 1, scope: "session", initial: () => ({ count: 0 }) });
  const storage = new CountingStorage();
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry(), settings: { documentRetentionMs: 0 } }, context);
  try {
    await harness.commit(async tx => { (await tx.doc(state)).count = 7; }, context);
    await Bun.sleep(20);
    expect(await harness.snapshot(state, context)).toEqual({ count: 7 });
    const reads = storage.documentReads;
    await Bun.sleep(20);
    expect(await harness.snapshot(state, context)).toEqual({ count: 7 });
    expect(storage.documentReads).toBeGreaterThan(reads);
    const watch = await harness.watchDoc(state, context);
    if (!watch) throw new Error("Expected persisted document watch");
    try {
      watch.start(async () => {});
      const observedReads = storage.documentReads;
      await Bun.sleep(20);
      expect(await harness.snapshot(state, context)).toEqual({ count: 7 });
      expect(storage.documentReads).toBe(observedReads);
      await harness.commit(async tx => { (await tx.doc(state)).count = 8; }, context);
      expect(await harness.snapshot(state, context)).toEqual({ count: 8 });
    } finally { await watch.stop(); }
    await Bun.sleep(20);
    expect(await harness.snapshot(state, context)).toEqual({ count: 8 });
  } finally { await harness.close(context); }
});
