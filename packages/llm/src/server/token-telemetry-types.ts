import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { invalidArguments } from "@kintsugi/core";

export const telemetryConfigSchema = Type.Object({
  enabled: Type.Boolean(), host: Type.String({ maxLength: 253 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  instance: Type.String({ minLength: 1, maxLength: 80 }),
  intervalMinutes: Type.Integer({ minimum: 1, maximum: 60 }),
}, { additionalProperties: false });
export type TelemetryConfig = Static<typeof telemetryConfigSchema>;
export const tokenFields = ["input", "output", "cache_read", "cache_write", "reasoning", "total"] as const;
export const accountingFields = [...tokenFields, "cache_write_1h", "cost"] as const;
const count = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const tokenUsageSchema = Type.Object({
  cache_complete: Type.Optional(Type.Boolean()),
  input: count, output: count, cache_read: Type.Optional(count), cache_write: Type.Optional(count),
  reasoning: Type.Optional(count), cache_write_1h: Type.Optional(count), total: count, cost: Type.Optional(count),
});
export type TokenUsage = Static<typeof tokenUsageSchema>;
export interface TelemetryUsage { id: string; provider: string; model: string; usage: TokenUsage }
export interface TelemetryCounter extends TelemetryUsage { /* id identifies a physical, non-inherited usage bucket. */ }
export interface TelemetrySnapshotSource { id: string; read(): Promise<TelemetryCounter[]> }
export interface MetricPoint { path: string; value: number; timestamp: number }

/** A percentage needs every prompt component, across every contributing record. */
export function cacheUsageComplete(usage: TokenUsage): boolean {
  return usage.cache_complete !== false && usage.cache_read !== undefined && usage.cache_write !== undefined;
}

/** Same path-segment normalisation as PiClaw's observability add-on. */
export function graphiteSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 128) || "unknown";
}

// External settings boundary: reject URL schemes, paths, whitespace and Carbon line injection.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- External persisted/HTTP settings are schema-validated here.
export function parseTelemetryConfig(value: unknown): TelemetryConfig {
  if (!Value.Check(telemetryConfigSchema, value)) throw invalidArguments("Invalid telemetry settings: use a host, port 1–65535, instance name and interval of 1–60 minutes.");
  const config = { ...value, host: value.host.trim(), instance: graphiteSegment(value.instance) };
  if (config.host && !/^[a-zA-Z0-9_.:-]+$/.test(config.host)) throw invalidArguments("Enter a hostname or IP address, without a URL scheme or path.");
  if (config.instance === "unknown" && !/[a-zA-Z0-9]/.test(value.instance)) throw invalidArguments("Enter an instance name containing letters or numbers.");
  if (config.enabled && !config.host) throw invalidArguments("A Graphite host is required when export is enabled.");
  return config;
}

export function metricPoints(config: TelemetryConfig, records: readonly Pick<TelemetryUsage, "provider" | "model" | "usage">[], timestamp: number): MetricPoint[] {
  const grouped = new Map<string, TokenUsage>();
  for (const { provider, model, usage } of records) {
    Value.Assert(tokenUsageSchema, usage);
    const path = `kintsugi.${graphiteSegment(config.instance)}.usage.${graphiteSegment(provider)}.${graphiteSegment(model)}`;
    const totals = grouped.get(path) ?? { input: 0, output: 0, total: 0, cache_complete: true };
    totals.cache_complete = totals.cache_complete === true && cacheUsageComplete(usage);
    for (const field of accountingFields) {
      if (usage[field] !== undefined) totals[field] = (totals[field] ?? 0) + usage[field];
    }
    grouped.set(path, totals);
  }
  return [...grouped].flatMap(([path, usage]) => {
    const points = tokenFields.flatMap(field => usage[field] === undefined ? [] : [{ path: `${path}.tokens.${field}`, value: usage[field], timestamp }]);
    if (usage.cost !== undefined) points.push({ path: `${path}.cost.estimated_usd`, value: usage.cost, timestamp });
    if (cacheUsageComplete(usage)) {
      const prompt = usage.input + usage.cache_read! + usage.cache_write!;
      points.push({ path: `${path}.tokens.prompt`, value: prompt, timestamp });
      if (prompt > 0) {
        points.push({ path: `${path}.cache.hit_percent`, value: usage.cache_read! / prompt * 100, timestamp });
        points.push({ path: `${path}.cache.write_percent`, value: usage.cache_write! / prompt * 100, timestamp });
      }
    }
    return points;
  });
}

/** Optional counters stay unknown until a backend reports them. Reasoning is a subset of output. */
export function counterDelta(current: TokenUsage, previous: TokenUsage): TokenUsage {
  const delta: TokenUsage = { input: 0, output: 0, total: 0 };
  for (const field of accountingFields) {
    const next = current[field], before = previous[field];
    if (next !== undefined) delta[field] = before === undefined ? next : Math.max(0, next - before);
  }
  delta.cache_complete = cacheUsageComplete(current) && cacheUsageComplete(previous);
  return delta;
}
