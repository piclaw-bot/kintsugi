import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { isJsonObject, isNotFoundError, type JsonObject, type JsonValue } from "@kintsugi/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { counterDelta, tokenUsageSchema, type TelemetryUsage, type TokenUsage } from "./token-telemetry-types.ts";
import type { TokenTelemetryStore, TelemetryFileCursor } from "./token-telemetry-store.ts";

export type NativeUsageFormat = "claude" | "codex" | "pi";
export interface NativeUsageFile { path: string; format: NativeUsageFormat }
const nativeStateSchema = Type.Object({
  model: Type.String(), provider: Type.Optional(Type.String()), session: Type.String(), turn: Type.String(),
  piContexts: Type.Optional(Type.Array(Type.Object({ id: Type.String(), provider: Type.Optional(Type.String()), model: Type.String() }), { maxItems: 128 })),
  totals: Type.Optional(tokenUsageSchema),
});
export type NativeUsageState = Static<typeof nativeStateSchema>;
const emptyState = (): NativeUsageState => ({ model: "unknown", session: "", turn: "" });
const nonnegative = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const string = Type.String({ maxLength: 512 });
function text(value: JsonValue | undefined): string | undefined { return Value.Check(string, value) ? value : undefined; }
function number(value: JsonValue | undefined): number | undefined { return Value.Check(nonnegative, value) ? value : undefined; }
function object(value: JsonValue | undefined): JsonObject | undefined { return isJsonObject(value) ? value : undefined; }
function date(value: JsonValue | undefined): number { return Value.Check(Type.Number(), value) ? value : Date.parse(text(value) ?? ""); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function piUsage(value: JsonObject): TokenUsage | undefined {
  const input = number(value.input), output = number(value.output);
  if (input === undefined || output === undefined) return;
  const cache_read = number(value.cacheRead), cache_write = number(value.cacheWrite);
  return { input, output, cache_read, cache_write, reasoning: number(value.reasoning),
    total: number(value.totalTokens) ?? input + output + (cache_read ?? 0) + (cache_write ?? 0),
    cost: number(object(value.cost)?.total) };
}
function claudeUsage(value: JsonObject): TokenUsage | undefined {
  const input = number(value.input_tokens), output = number(value.output_tokens);
  if (input === undefined || output === undefined) return;
  const cache_read = number(value.cache_read_input_tokens), cache_write = number(value.cache_creation_input_tokens);
  return { input, output, cache_read, cache_write, cache_write_1h: number(object(value.cache_creation)?.ephemeral_1h_input_tokens), total: input + output + (cache_read ?? 0) + (cache_write ?? 0) };
}
function codexUsage(value: JsonObject): TokenUsage | undefined {
  const input = number(value.input_tokens), output = number(value.output_tokens);
  if (input === undefined || output === undefined) return;
  const cache_read = number(value.cached_input_tokens);
  return { input: Math.max(0, input - (cache_read ?? 0)), output, cache_read, cache_write: 0,
    reasoning: number(value.reasoning_output_tokens), total: number(value.total_tokens) ?? input + output };
}

/** An explicit identity change must not combine a new provider with a previous model (or the reverse). */
function rememberIdentity(state: NativeUsageState, provider: string | undefined, model: string | undefined) {
  if (provider && provider !== state.provider && !model) state.model = "unknown";
  if (model && model !== state.model && !provider) state.provider = undefined;
  if (provider) state.provider = provider;
  if (model) state.model = model;
}

/** Auxiliary usage cannot inherit the conversation model: tools and summaries can call other models. */
function explicitPiUsageIdentity(record: JsonObject, usage: JsonObject): { provider: string; model: string } | undefined {
  for (const candidate of [record, usage, object(record.details)]) {
    if (!candidate) continue;
    const ref = object(candidate.model);
    const provider = text(candidate.provider) ?? text(ref?.provider);
    const model = text(candidate.responseModel) ?? text(candidate.response_model) ?? text(candidate.model) ?? text(ref?.id);
    if (provider && model) return { provider, model };
  }
  return;
}

/** Pi code mode stores one combined usage plus model/cost call rows. A single model is exactly attributable. */
function homogeneousPiCodemodeIdentity(message: JsonObject): { provider: string; model: string } | undefined {
  if (message.toolName !== "codemode") return;
  const calls = object(message.details)?.calls;
  if (!Array.isArray(calls)) return;
  const references = new Set<string>();
  for (const value of calls) {
    const call = object(value);
    if (!call || (call.name !== "models.classify" && call.name !== "models.generateImages") || number(call.cost) === undefined) continue;
    const ref = text(call.args);
    if (!ref || ref.indexOf("/") <= 0 || ref.endsWith("/")) return;
    references.add(ref);
  }
  if (references.size !== 1) return;
  const ref = [...references][0]!, slash = ref.indexOf("/");
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/** Native histories are external input. Billing follows physical responses, including abandoned branches/subagents. */
export function nativeUsageRecords(format: NativeUsageFormat, row: JsonObject, state: NativeUsageState, cutoff: number, identity: string): TelemetryUsage[] {
  if (format === "codex") {
    const payload = object(row.payload);
    if (!payload) return [];
    if (row.type === "session_meta") {
      const session = text(payload.id);
      if (session && session !== state.session) { state.model = "unknown"; state.provider = undefined; state.turn = ""; state.totals = undefined; }
      state.session = session ?? state.session;
      const nativeProvider = text(payload.model_provider);
      rememberIdentity(state, nativeProvider === "openai" ? "openai-codex" : nativeProvider, text(payload.model));
    }
    if (row.type === "turn_context") {
      const nativeProvider = text(payload.model_provider);
      // The registered Codex agents use ChatGPT by default; explicit native custom providers remain distinct.
      rememberIdentity(state, nativeProvider ? nativeProvider === "openai" ? "openai-codex" : nativeProvider : state.provider ?? "openai-codex", text(payload.model));
      state.turn = text(payload.turn_id) ?? state.turn;
    }
    if (row.type === "event_msg" && (payload.type === "task_started" || payload.type === "turn_started")) state.turn = text(payload.turn_id) ?? state.turn;
    if (row.type !== "event_msg" || payload.type !== "token_count") return [];
    const info = object(payload.info), total = object(info?.total_token_usage), last = object(info?.last_token_usage);
    const totals = total && codexUsage(total);
    if (!totals) return [];
    const previous = state.totals;
    state.totals = totals;
    if (!(date(row.timestamp) >= cutoff)) return [];
    const usage = previous ? counterDelta(totals, previous) : last && codexUsage(last);
    if (!usage) return [];
    const origin = state.turn || state.session || identity;
    return [{ id: `codex:${hash(`${origin}:${JSON.stringify(totals)}`)}`, provider: state.provider ?? "openai-codex", model: state.model, usage }];
  }
  const message = object(row.message);
  if (format === "claude") {
    if (row.type === "system" && row.subtype === "init") rememberIdentity(state, "anthropic", text(row.model));
    if (row.type !== "assistant" || !message) return [];
    rememberIdentity(state, "anthropic", text(message.model));
    if (!(date(row.timestamp) >= cutoff)) return [];
    const raw = object(message.usage), usage = raw && claudeUsage(raw), id = text(message.id) ?? text(row.uuid);
    if (!usage || !id) return [];
    return [{ id: `claude:${id}`, provider: "anthropic", model: state.model, usage }];
  }
  if (row.type === "session") {
    const session = text(row.id);
    if (session && session !== state.session) { state.model = "unknown"; state.provider = undefined; state.piContexts = []; }
    state.session = session ?? state.session;
    return [];
  }
  // Pi is a tree. Recover only the recorded parent's context, never a sibling branch's last model.
  if (Object.hasOwn(row, "parentId")) {
    const parent = text(row.parentId), inherited = state.piContexts?.findLast(entry => entry.id === parent);
    state.provider = inherited?.provider; state.model = inherited?.model ?? "unknown";
  }
  if (row.type === "model_change") rememberIdentity(state, text(row.provider), text(row.modelId));
  if (row.type === "message" && message?.role === "assistant") rememberIdentity(state, text(message.provider), text(message.responseModel) ?? text(message.model));
  const id = text(row.id);
  if (id) {
    state.piContexts ??= [];
    state.piContexts.push({ id, provider: state.provider, model: state.model });
    if (state.piContexts.length > 128) state.piContexts.shift();
  }
  if (!id || !(date(row.timestamp) >= cutoff)) return [];
  if (row.type === "usage") {
    // Pi's model-attributed ledger includes cache-warming requests; it is separate from chat messages.
    const raw = object(row.usage), usage = raw && piUsage(raw), provider = text(row.provider) ?? "unknown", model = text(row.model) ?? "unknown";
    return usage ? [{ id: `pi:${hash(`${provider}:${id}:${date(row.timestamp)}`)}`, provider: provider !== "unknown" && model !== "unknown" ? provider : "unattributed", model: provider !== "unknown" && model !== "unknown" ? model : "pi_usage", usage }] : [];
  }
  const auxiliary = row.type === "compaction" || row.type === "branch_summary"
    ? row : row.type === "message" && message?.role === "toolResult" ? message : undefined;
  if (auxiliary) {
    const raw = object(auxiliary.usage), usage = raw && piUsage(raw);
    if (!raw || !usage) return [];
    const model = explicitPiUsageIdentity(auxiliary, raw) ?? (auxiliary === message ? homogeneousPiCodemodeIdentity(auxiliary) : undefined);
    const attributed = model ?? { provider: "unattributed", model: row.type === "compaction" ? "pi_compaction" : row.type === "branch_summary" ? "pi_branch_summary" : "pi_tools" };
    return [{ id: `pi-extra:${hash(`${row.type}:${id}:${date(row.timestamp)}`)}`, ...attributed, usage }];
  }
  if (row.type !== "message" || message?.role !== "assistant") return [];
  const raw = object(message.usage), usage = raw && piUsage(raw);
  if (!usage) return [];
  // Retain the original message-based deduplication key when metadata recovery improves attribution.
  const originalProvider = text(message.provider) ?? "unknown";
  const attributed = state.provider && state.provider !== "unknown" && state.model !== "unknown";
  return [{ id: `pi:${hash(`${originalProvider}:${id}:${date(row.timestamp)}`)}`, provider: attributed ? state.provider! : "unattributed", model: attributed ? state.model : "pi_assistant", usage }];
}

/** Whitelist canonical native roots. Session-share exports are copies and are deliberately excluded. */
export async function discoverNativeUsageFiles(dataDir: string): Promise<NativeUsageFile[]> {
  const files: NativeUsageFile[] = [];
  let visited = 0;
  async function walk(directory: string, format: NativeUsageFormat, depth = 0): Promise<void> {
    if (depth > 12) throw new Error("Native usage history exceeds the directory depth limit.");
    let handle;
    try { handle = await opendir(directory); }
    catch (error) { if (isNotFoundError(error)) return; throw error; }
    for await (const entry of handle) {
      if (++visited > 50_000) throw new Error("Native usage discovery exceeds 50,000 entries.");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, format, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (files.length >= 10_000) throw new Error("Native usage discovery exceeds 10,000 history files.");
        files.push({ path, format });
      }
    }
  }
  await walk(join(dataDir, "home/.claude/projects"), "claude");
  await walk(join(dataDir, "home/.codex/sessions"), "codex");
  let workspaces;
  try { workspaces = await opendir(join(dataDir, "workspaces")); }
  catch (error) { if (isNotFoundError(error)) return files; throw error; }
  for await (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const local = join(dataDir, "workspaces", workspace.name, "home-local/.local/share");
    await walk(join(local, "pi/sessions"), "pi");
    let agents;
    try { agents = await opendir(join(local, "kintsugi-agents")); }
    catch (error) { if (isNotFoundError(error)) continue; throw error; }
    for await (const agent of agents) {
      if (!agent.isDirectory()) continue;
      await walk(join(local, "kintsugi-agents", agent.name, "claude/projects"), "claude");
      await walk(join(local, "kintsugi-agents", agent.name, "codex/sessions"), "codex");
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const maxRowBytes = 2 * 1024 * 1024;
const maxReadBytes = 1024 * 1024;
const maxPollBytes = 16 * 1024 * 1024;

async function openHistory(file: NativeUsageFile, dataDir: string) {
  const canonical = await realpath(file.path), root = await realpath(dataDir);
  const child = relative(root, canonical);
  if (child === ".." || child.startsWith(`..${sep}`) || !child) throw new Error("Native usage history escaped the application data directory.");
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = await handle.stat();
  if (!stat.isFile()) { await handle.close(); throw new Error("Native usage history is not a regular file."); }
  return { handle, stat, identity: `${stat.dev}:${stat.ino}` };
}

/** Enabling skips existing bytes, including a half-written row. Seed Codex's cumulative baseline from a bounded tail. */
export async function baselineNativeUsage(dataDir: string, store: TokenTelemetryStore) {
  const files = await discoverNativeUsageFiles(dataDir);
  for (const file of files) {
    let opened;
    try { opened = await openHistory(file, dataDir); }
    catch (error) { if (isNotFoundError(error)) continue; throw error; }
    const { handle, stat, identity } = opened;
    try {
      const baselineBytes = maxRowBytes;
      const offset = Math.max(0, stat.size - baselineBytes), buffer = Buffer.alloc(Math.min(stat.size, baselineBytes));
      await handle.read(buffer, 0, buffer.length, offset);
      const lines = buffer.toString("utf8").split("\n"), state = emptyState();
      if (offset && file.format === "codex") {
        // Provider/session identity is in Codex's header, which may be far outside the recent-usage tail.
        // Do not seed a mutable model from that old prefix; the tail owns the latest turn's model.
        const prefix = Buffer.alloc(Math.min(stat.size, maxReadBytes));
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        const end = prefix.subarray(0, bytesRead).indexOf(10);
        if (end >= 0) {
          try {
            const header: unknown = JSON.parse(prefix.subarray(0, end).toString("utf8"));
            const payload = isJsonObject(header) && header.type === "session_meta" ? object(header.payload) : undefined;
            if (payload) nativeUsageRecords("codex", { type: "session_meta", payload: { id: payload.id ?? null, model_provider: payload.model_provider ?? null } }, state, Infinity, identity);
          } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
      }
      if (offset) lines.shift();
      lines.pop(); // an incomplete row cannot establish a usage baseline
      for (const line of lines) {
        try { const row: unknown = JSON.parse(line); if (isJsonObject(row)) nativeUsageRecords(file.format, row, state, Infinity, identity); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      store.saveCursor(file.path, { offset: stat.size, identity, skipping: stat.size > 0 && buffer.at(-1) !== 10, metadata: JSON.stringify(state) });
    } finally { await handle.close(); }
  }
}

/** Incremental bounded reads; cursor and counted events commit atomically, so a crash can safely replay a chunk. */
export async function collectNativeUsage(dataDir: string, store: TokenTelemetryStore, cutoff: number, estimate: (record: TelemetryUsage) => void): Promise<void> {
  const files = await discoverNativeUsageFiles(dataDir);
  const after = store.state("lastFile") ?? "";
  const ordered = [...files.filter(file => file.path > after), ...files.filter(file => file.path <= after)];
  let read = 0;
  for (const file of ordered) {
    if (read >= maxPollBytes) break;
    let opened;
    try { opened = await openHistory(file, dataDir); }
    catch (error) { if (isNotFoundError(error)) continue; throw error; }
    const { handle, stat, identity } = opened;
    try {
      const saved = store.cursor(file.path);
      const cursor: TelemetryFileCursor = saved && saved.identity === identity && saved.offset <= stat.size ? { ...saved } : { offset: 0, identity, skipping: false, metadata: JSON.stringify(emptyState()) };
      const state = Value.Parse(nativeStateSchema, JSON.parse(cursor.metadata));
      const buffer = Buffer.alloc(Math.min(maxReadBytes, stat.size - cursor.offset));
      if (!buffer.length) continue;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
      read += bytesRead;
      let consumed = 0;
      const records: TelemetryUsage[] = [];
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue;
        const line = buffer.subarray(consumed, index).toString("utf8");
        consumed = index + 1;
        if (cursor.skipping) { cursor.skipping = false; continue; }
        try {
          const row: unknown = JSON.parse(line);
          if (isJsonObject(row)) records.push(...nativeUsageRecords(file.format, row, state, cutoff, identity));
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; store.increment("invalidRows"); }
      }
      // Grow a bounded read for a long complete row on the next pass, rather than allocating an entire history.
      if (!consumed && bytesRead === maxReadBytes) {
        const extra = Buffer.alloc(Math.min(maxRowBytes, stat.size - cursor.offset));
        const result = await handle.read(extra, 0, extra.length, cursor.offset);
        const end = extra.subarray(0, result.bytesRead).indexOf(10);
        if (end >= 0) {
          consumed = end + 1;
          if (!cursor.skipping) {
            try { const row: unknown = JSON.parse(extra.subarray(0, end).toString("utf8")); if (isJsonObject(row)) records.push(...nativeUsageRecords(file.format, row, state, cutoff, identity)); }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; store.increment("invalidRows"); }
          }
          cursor.skipping = false;
        } else if (result.bytesRead === maxRowBytes) { consumed = result.bytesRead; if (!cursor.skipping) store.increment("oversizedRows"); cursor.skipping = true; }
        read += result.bytesRead;
      }
      store.transaction(() => {
        for (const record of records) { estimate(record); store.event(record); }
        store.saveCursor(file.path, { ...cursor, offset: cursor.offset + consumed, metadata: JSON.stringify(state) });
        store.setState("lastFile", file.path);
      });
    } finally { await handle.close(); }
  }
}
