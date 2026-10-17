import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Value } from "typebox/value";
import { accountingFields, cacheUsageComplete, counterDelta, metricPoints, tokenUsageSchema, type TelemetryConfig, type TelemetryUsage, type TokenUsage } from "./token-telemetry-types.ts";

export const maxTelemetrySpoolBytes = 10 * 1024 * 1024;
export const maxTelemetrySpoolAgeMs = 7 * 24 * 60 * 60_000;
export interface TelemetryFileCursor { offset: number; identity: string; skipping: boolean; metadata: string }

/** Only counts, opaque deduplication keys and read offsets are retained; never conversation content. */
export class TokenTelemetryStore {
  readonly db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, usage TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (source TEXT NOT NULL, id TEXT NOT NULL, usage TEXT NOT NULL, PRIMARY KEY(source,id));
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, offset INTEGER NOT NULL, identity TEXT NOT NULL, skipping INTEGER NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (provider TEXT NOT NULL, model TEXT NOT NULL, usage TEXT NOT NULL, PRIMARY KEY(provider,model));
      CREATE TABLE IF NOT EXISTS batches (id INTEGER PRIMARY KEY, created INTEGER NOT NULL, payload TEXT NOT NULL);
    `);
  }
  transaction<T>(run: () => T): T { return this.db.transaction(run)(); }
  state(key: string): string | undefined { return this.db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key)?.value; }
  setState(key: string, value: string) { this.db.query("INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  increment(key: string, amount = 1) { this.setState(key, String(Number(this.state(key) ?? 0) + amount)); }
  cursor(path: string): TelemetryFileCursor | undefined {
    const row = this.db.query<{ offset: number; identity: string; skipping: number; metadata: string }, [string]>("SELECT offset,identity,skipping,metadata FROM files WHERE path=?").get(path);
    return row ? { ...row, skipping: row.skipping === 1 } : undefined;
  }
  saveCursor(path: string, cursor: TelemetryFileCursor) {
    this.db.query("INSERT INTO files VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,identity=excluded.identity,skipping=excluded.skipping,metadata=excluded.metadata").run(path, cursor.offset, cursor.identity, cursor.skipping ? 1 : 0, cursor.metadata);
  }
  private parseUsage(text: string): TokenUsage { return Value.Parse(tokenUsageSchema, JSON.parse(text)); }
  private add(provider: string, model: string, usage: TokenUsage) {
    Value.Assert(tokenUsageSchema, usage);
    if (!accountingFields.some(field => (usage[field] ?? 0) > 0)) return;
    const row = this.db.query<{ usage: string }, [string, string]>("SELECT usage FROM pending WHERE provider=? AND model=?").get(provider, model);
    if (!row && this.pending() >= 256) throw new Error("Token telemetry has 256 pending provider/model series; waiting for the next bounded export batch.");
    const combined = row ? this.parseUsage(row.usage) : { input: 0, output: 0, total: 0 };
    combined.cache_complete = (!row || combined.cache_complete === true) && cacheUsageComplete(usage);
    for (const key of accountingFields) {
      if (usage[key] !== undefined) combined[key] = (combined[key] ?? 0) + usage[key];
    }
    Value.Assert(tokenUsageSchema, combined);
    this.db.query("INSERT INTO pending VALUES (?,?,?) ON CONFLICT(provider,model) DO UPDATE SET usage=excluded.usage").run(provider, model, JSON.stringify(combined));
  }
  event(record: TelemetryUsage) {
    const previous = this.db.query<{ usage: string }, [string]>("SELECT usage FROM events WHERE id=?").get(record.id);
    const usage = previous ? counterDelta(record.usage, this.parseUsage(previous.usage)) : record.usage;
    this.add(record.provider, record.model, usage);
    // Keep maxima: a partial replay must not lower the deduplication baseline.
    const stored = previous ? this.parseUsage(previous.usage) : record.usage;
    for (const key of accountingFields) {
      if (record.usage[key] !== undefined) stored[key] = Math.max(stored[key] ?? 0, record.usage[key]);
    }
    stored.cache_complete = record.usage.cache_complete;
    this.db.query("INSERT INTO events VALUES (?,?) ON CONFLICT(id) DO UPDATE SET usage=excluded.usage").run(record.id, JSON.stringify(stored));
  }
  counter(source: string, record: TelemetryUsage, baseline = false) {
    const previous = this.db.query<{ usage: string }, [string, string]>("SELECT usage FROM counters WHERE source=? AND id=?").get(source, record.id);
    if (!baseline) this.add(record.provider, record.model, previous ? counterDelta(record.usage, this.parseUsage(previous.usage)) : record.usage);
    const stored = previous && !baseline ? this.parseUsage(previous.usage) : record.usage;
    for (const key of accountingFields) {
      if (record.usage[key] !== undefined) stored[key] = Math.max(stored[key] ?? 0, record.usage[key]);
    }
    stored.cache_complete = record.usage.cache_complete;
    this.db.query("INSERT INTO counters VALUES (?,?,?) ON CONFLICT(source,id) DO UPDATE SET usage=excluded.usage").run(source, record.id, JSON.stringify(stored));
  }
  hasSource(source: string): boolean { return Boolean(this.state(`source:${source}`)); }
  markSource(source: string) { this.setState(`source:${source}`, "1"); }
  clearBaselines() { this.db.exec("DELETE FROM counters; DELETE FROM files; DELETE FROM state WHERE key LIKE 'source:%'"); }
  pending(): number { return this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM pending").get()!.count; }
  batch(config: TelemetryConfig, now: number) {
    const rows = this.db.query<{ provider: string; model: string; usage: string }, []>("SELECT * FROM pending ORDER BY provider,model").all();
    const points = metricPoints(config, rows.map(row => ({ ...row, usage: this.parseUsage(row.usage) })), Math.floor(now / 1000));
    if (points.length) {
      const payload = points.map(point => `${point.path} ${point.value} ${point.timestamp}\n`).join("");
      this.db.query("INSERT INTO batches(created,payload) VALUES (?,?)").run(now, payload);
      this.db.exec("DELETE FROM pending");
    }
    this.setState("lastBatch", String(now));
    this.trim(now);
  }
  trim(now: number) {
    const expired = this.db.query("DELETE FROM batches WHERE created < ?").run(now - maxTelemetrySpoolAgeMs).changes;
    if (expired) this.increment("droppedBatches", expired);
    while (this.spoolBytes() > maxTelemetrySpoolBytes) {
      this.db.exec("DELETE FROM batches WHERE id = (SELECT min(id) FROM batches)");
      this.increment("droppedBatches");
    }
  }
  spoolBytes(): number { return this.db.query<{ bytes: number }, []>("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM batches").get()!.bytes; }
  queued(): number { return this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM batches").get()!.count; }
  nextBatch() { return this.db.query<{ id: number; payload: string }, []>("SELECT id,payload FROM batches ORDER BY id LIMIT 1").get(); }
  nextBatches() {
    const batches: { id: number; payload: string }[] = [];
    let bytes = 0;
    for (const row of this.db.query<{ id: number; payload: string }, []>("SELECT id,payload FROM batches ORDER BY id").iterate()) {
      const size = Buffer.byteLength(row.payload);
      if (bytes + size > 4 * 1024 * 1024) break;
      batches.push(row); bytes += size;
      if (batches.length === 128) break;
    }
    return batches;
  }
  delivered(id: number, now: number) { this.db.query("DELETE FROM batches WHERE id=?").run(id); this.setState("lastSuccess", String(now)); this.setState("lastError", ""); }
  discard() { const count = this.queued(); this.db.exec("DELETE FROM batches; DELETE FROM pending"); this.increment("droppedBatches", count); }
  close() { this.db.close(); }
}
