import { createConnection } from "node:net";
import { join } from "node:path";
import { getKintsugiRuntimeContext, isNotFoundError, writeJsonAtomic } from "@kintsugi/core";
import { calculateCost, type AnyModel } from "@earendil-works/pi-ai";
import { createPiModelRuntime } from "./pi-config-models.ts";
import { baselineNativeUsage, collectNativeUsage } from "./token-telemetry-native.ts";
import { TokenTelemetryStore } from "./token-telemetry-store.ts";
import { parseTelemetryConfig, type TelemetryConfig, type TelemetrySnapshotSource, type TelemetryUsage } from "./token-telemetry-types.ts";
export type { TelemetryCounter, TelemetrySnapshotSource } from "./token-telemetry-types.ts";

/** Carbon plaintext acknowledges a TCP write, not storage. A crash after delivery may replay the same path/timestamp. */
export async function sendCarbon(host: string, port: number, payload = ""): Promise<void> {
  if (!host) throw new Error("Enter a Graphite host before testing the connection.");
  if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error("Graphite batch exceeds the 4 MiB transport limit.");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timeout = setTimeout(() => socket.destroy(new Error("Graphite connection timed out after 5 seconds.")), 5000);
    socket.once("connect", () => socket.end(payload));
    socket.once("error", reject);
    socket.once("close", error => { clearTimeout(timeout); if (!error) resolve(); });
  });
}

export function estimateTelemetryCost(record: TelemetryUsage, model: AnyModel | undefined) {
  if (record.usage.cost !== undefined || !model || record.usage.cache_read === undefined || record.usage.cache_write === undefined) return;
  const usage = { input: record.usage.input, output: record.usage.output,
    cacheRead: record.usage.cache_read, cacheWrite: record.usage.cache_write, cacheWrite1h: record.usage.cache_write_1h,
    totalTokens: record.usage.total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  record.usage.cost = calculateCost(model, usage).total;
}

export class TokenTelemetry {
  private readonly configPath: string;
  private configuration?: TelemetryConfig;
  private configurationLoad?: Promise<void>;
  private store?: TokenTelemetryStore;
  private timer?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();
  private readonly sources = new Map<string, TelemetrySnapshotSource>();
  private failure = "";
  private closed = false;
  private readonly defaultInstance = `kintsugi-${crypto.randomUUID().slice(0, 8)}`;
  constructor(readonly dataDir: string, private readonly now = Date.now, private readonly send = sendCarbon) {
    this.configPath = join(dataDir, "telemetry/config.json");
  }
  private database() { return this.store ??= new TokenTelemetryStore(join(this.dataDir, "telemetry/usage.sqlite")); }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  async config(): Promise<TelemetryConfig> {
    if (!this.configuration) {
      this.configurationLoad ??= (async () => {
        try { this.configuration = parseTelemetryConfig(await Bun.file(this.configPath).json()); }
        catch (error) {
          if (!isNotFoundError(error)) throw error;
          this.configuration = { enabled: false, host: "", port: 2003, instance: this.defaultInstance, intervalMinutes: 15 };
        }
      })();
      await this.configurationLoad;
    }
    return { ...this.configuration! };
  }
  async status() {
    const config = await this.config();
    const db = this.store ?? ((config.enabled || await Bun.file(join(this.dataDir, "telemetry/usage.sqlite")).exists()) ? this.database() : undefined);
    return { config, prefix: `kintsugi.${config.instance}.usage`,
      pendingSeries: db?.pending() ?? 0, queuedBatches: db?.queued() ?? 0, queuedBytes: db?.spoolBytes() ?? 0,
      lastSuccess: db?.state("lastSuccess") ? new Date(Number(db.state("lastSuccess"))).toISOString() : null,
      lastError: this.failure || db?.state("lastError") || null,
      droppedBatches: Number(db?.state("droppedBatches") ?? 0),
      oversizedRows: Number(db?.state("oversizedRows") ?? 0), invalidRows: Number(db?.state("invalidRows") ?? 0),
    };
  }
  async configure(input: TelemetryConfig): Promise<TelemetryConfig> {
    const next = parseTelemetryConfig(input);
    return this.serialize(async () => {
      const current = await this.config(), db = this.database();
      if ((db.queued() || db.pending()) && (next.host !== current.host || next.port !== current.port || next.instance !== current.instance)) {
        throw new Error("Pending exports belong to the saved destination and instance. Deliver or discard them before changing either.");
      }
      if (next.enabled && !current.enabled) {
        db.clearBaselines();
        await baselineNativeUsage(this.dataDir, db);
        for (const source of this.sources.values()) {
          const counters = await source.read();
          db.transaction(() => { for (const record of counters) db.counter(source.id, record, true); db.markSource(source.id); });
        }
        const now = this.now();
        db.setState("enabledAt", String(now));
        db.setState("lastBatch", String(now));
      }
      await writeJsonAtomic(this.configPath, next, { mode: 0o600 });
      this.configuration = next;
      this.schedule();
      return { ...next };
    });
  }
  /** Baseline a runtime before it can execute. Reopening a known journal retains its committed counters. */
  async register(source: TelemetrySnapshotSource): Promise<() => Promise<void>> {
    this.sources.set(source.id, source);
    try {
      await this.serialize(async () => {
        if (!(await this.config()).enabled) return;
        const db = this.database();
        if (db.hasSource(source.id)) return;
        const counters = await source.read();
        db.transaction(() => { for (const record of counters) db.counter(source.id, record, true); db.markSource(source.id); });
      });
    } catch (error) { this.report(error); }
    return async () => {
      try {
        await this.serialize(async () => {
          if (this.sources.get(source.id) !== source) return;
          if ((await this.config()).enabled) {
            const counters = await source.read(), db = this.database();
            db.transaction(() => { for (const record of counters) db.counter(source.id, record); });
          }
          this.sources.delete(source.id);
        });
      } catch (error) { this.sources.delete(source.id); this.report(error); }
    };
  }
  async collect() {
    return this.serialize(async () => {
      if (this.closed || !(await this.config()).enabled) return;
      const db = this.database();
      for (const source of this.sources.values()) {
        const counters = await source.read();
        db.transaction(() => { for (const record of counters) db.counter(source.id, record); db.markSource(source.id); });
      }
      // Model registry creation reads app configuration only; it never opens a workspace or calls a provider.
      const models = await createPiModelRuntime().catch(error => { this.report(error); return undefined; });
      await collectNativeUsage(this.dataDir, db, Number(db.state("enabledAt")), record => estimateTelemetryCost(record, models?.getModel(record.provider, record.model)));
    });
  }
  async flush(force = false) {
    return this.serialize(async () => {
      const config = await this.config();
      if (this.closed || !config.enabled) return;
      const db = this.database(), now = this.now();
      db.transaction(() => {
        if (force || now - Number(db.state("lastBatch") ?? 0) >= config.intervalMinutes * 60_000) db.batch(config, now);
        else db.trim(now);
      });
      const batches = db.nextBatches();
      if (batches.length) {
        await this.send(config.host, config.port, batches.map(batch => batch.payload).join(""));
        db.transaction(() => { for (const batch of batches) db.delivered(batch.id, this.now()); });
        this.failure = "";
      }
    });
  }
  async test(input: TelemetryConfig) { const config = parseTelemetryConfig(input); await this.send(config.host, config.port); }
  async discard() { return this.serialize(async () => { this.database().transaction(() => this.database().discard()); }); }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Central boundary for caught filesystem, source and network errors.
  private report(error: unknown) {
    this.failure = error instanceof Error ? error.message : String(error);
    try { this.store?.setState("lastError", this.failure); }
    catch (storageError) { console.error("Could not persist telemetry failure:", storageError); }
    console.error("Token telemetry export failed:", this.failure);
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.closed || !this.configuration?.enabled) return;
    this.timer = setTimeout(() => {
      void this.collect().catch(error => this.report(error))
        .then(() => this.flush()).catch(error => this.report(error)).finally(() => this.schedule());
    }, 30_000);
    this.timer.unref();
  }
  async start() {
    await this.serialize(async () => {
      if ((await this.config()).enabled && !this.database().state("enabledAt")) {
        await baselineNativeUsage(this.dataDir, this.database());
        this.database().setState("enabledAt", String(this.now()));
        this.database().setState("lastBatch", String(this.now()));
      }
    });
    this.schedule();
  }
  async close() { this.closed = true; clearTimeout(this.timer); await this.tail; this.store?.close(); }
}

const services = new Map<string, TokenTelemetry>();
export function tokenTelemetry(): TokenTelemetry {
  const data = getKintsugiRuntimeContext().kintsugiDataDir;
  let service = services.get(data);
  if (!service) { service = new TokenTelemetry(data); services.set(data, service); }
  return service;
}
