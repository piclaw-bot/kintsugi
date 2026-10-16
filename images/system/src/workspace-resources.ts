import { chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createKeyedOperationQueue, readTextIfExists, writeJsonAtomic } from "../../../packages/core/src/index.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const GiB = 1024 ** 3;
export function workspaceResourceDefaults(memory: number, cpus: number) {
  return { memory: Math.min(2 * GiB, Math.floor(memory / 2)), cpus: Math.max(0.25, Math.min(4, cpus)), pids: 1024 };
}
const limitsSchema = Type.Object({ memory: Type.Integer({ minimum: 6 * 1024 ** 2 }), memorySwap: Type.Integer({ minimum: 0 }), cpus: Type.Number({ exclusiveMinimum: 0 }), pids: Type.Integer({ minimum: 1 }) });
const recordSchema = Type.Object({ limits: limitsSchema, desiredRunning: Type.Optional(Type.Boolean()), oomKills: Type.Integer({ minimum: 0 }), blockedAt: Type.Optional(Type.Number()), reason: Type.Optional(Type.String()), source: Type.Optional(Type.String()), containerId: Type.Optional(Type.String()), observedOom: Type.Optional(Type.Number()), lastOomExit: Type.Optional(Type.String()), exitCode: Type.Optional(Type.Integer()), restartCount: Type.Optional(Type.Integer()), finishedAt: Type.Optional(Type.String()) });
type RecordState = Static<typeof recordSchema>;
// Docker is a privileged external boundary. Do not return its Env/Cmd/Error or arbitrary image metadata in diagnostics.
const inspectSchema = Type.Array(Type.Object({ Id: Type.String(), Name: Type.String(), Config: Type.Object({ Labels: Type.Union([Type.Null(), Type.Record(Type.String(), Type.String())]) }), State: Type.Object({ Running: Type.Boolean(), OOMKilled: Type.Boolean(), Pid: Type.Integer(), ExitCode: Type.Integer(), FinishedAt: Type.String() }), RestartCount: Type.Integer(), HostConfig: Type.Object({ Memory: Type.Number(), MemorySwap: Type.Number(), NanoCpus: Type.Number(), PidsLimit: Type.Union([Type.Null(), Type.Number()]) }) }));
type Container = Static<typeof inspectSchema>[number];
export function createWorkspaceResourceControl(options: { memory: number; cpus: number; cgroupParent: string; docker(...args: string[]): Promise<string>; file?: string; park?: (id: string) => Promise<void>; readOom?: (container: Container) => Promise<number>; now?: () => number }) {
  const file = options.file ?? "/data/supervisor/workspace-resources.json";
  const defaults = workspaceResourceDefaults(options.memory, options.cpus);
  const budget = Math.floor(options.memory * 0.8); // Leave room for source readers and image builds within the aggregate cap.
  const serialize = createKeyedOperationQueue();
  const pending = new Map<string, number>();
  const now = options.now ?? Date.now;
  let closing = false;
  let state: Record<string, RecordState>;
  async function load() { state ??= Value.Parse(Type.Record(Type.String(), recordSchema), JSON.parse(await readTextIfExists(file) ?? "{}")); }
  const save = () => writeJsonAtomic(file, state, { mode: 0o600 });
  const idOf = (c: Container) => { const id = c.Config.Labels?.["com.kintsugi.workspace-id"]; return id && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) && c.Config.Labels?.["com.kintsugi.type"] === "workspace" && c.Name === `/kintsugi-${id}` ? id : undefined; };
  async function containers() {
    const ids = (await options.docker("ps", "-aq", "--filter", "label=com.kintsugi.type=workspace")).split(/\s+/).filter(Boolean);
    return ids.length ? Value.Parse(inspectSchema, JSON.parse(await options.docker("inspect", ...ids))).filter(c => idOf(c)) : [];
  }
  function entry(c: Container): RecordState {
    const id = idOf(c)!;
    if (!Object.hasOwn(state, id)) {
      const memory = c.HostConfig.Memory || defaults.memory;
      state[id] = { limits: { memory, memorySwap: c.HostConfig.MemorySwap > 0 ? c.HostConfig.MemorySwap : memory, cpus: c.HostConfig.NanoCpus > 0 ? c.HostConfig.NanoCpus / 1e9 : defaults.cpus, pids: c.HostConfig.PidsLimit && c.HostConfig.PidsLimit > 0 ? c.HostConfig.PidsLimit : defaults.pids }, oomKills: 0 };
    }
    const current = state[id]!;
    if (current.containerId === c.Id) {
      const config = c.HostConfig;
      if (config.Memory > 0) current.limits.memory = config.Memory;
      if (config.MemorySwap > 0) current.limits.memorySwap = config.MemorySwap;
      if (config.NanoCpus > 0) current.limits.cpus = config.NanoCpus / 1e9;
      if (config.PidsLimit && config.PidsLimit > 0) current.limits.pids = config.PidsLimit;
    }
    return current;
  }
  async function apply(c: Container, e: RecordState) {
    const p = e.limits;
    if (p.memorySwap < p.memory || p.memory > budget) throw new Error("Workspace resource intent exceeds the admitted workload budget");
    await options.docker("update", "--memory", String(p.memory), "--memory-swap", String(p.memorySwap), "--cpus", String(p.cpus), "--pids-limit", String(p.pids), "--cpu-shares", "128", "--restart", "no", c.Id);
  }
  async function oom(c: Container) {
    if (options.readOom) return options.readOom(c);
    let processGroup: string;
    try { processGroup = await readFile(`/proc/${c.State.Pid}/cgroup`, "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    const membership = processGroup.trim().split("\n").find(l => l.startsWith("0::"))?.slice(3);
    if (!membership?.startsWith(options.cgroupParent + "/")) throw new Error("Workspace cgroup is outside its resource boundary");
    const parts = membership.split("/");
    const index = parts.findIndex(p => p === c.Id || p === `docker-${c.Id}.scope`);
    if (index < 0) throw new Error("Cannot identify the workspace cgroup");
    const root = join("/sys/fs/cgroup", parts.slice(0, index + 1).join("/"));
    await writeFile(join(root, "memory.oom.group"), "1");
    return Number((await readFile(join(root, "memory.events"), "utf8")).match(/^oom_kill (\d+)$/m)![1]);
  }
  async function observe(c: Container, e: RecordState) {
    if (e.containerId !== c.Id) { e.containerId = c.Id; e.observedOom = 0; }
    e.exitCode = c.State.ExitCode; e.restartCount = c.RestartCount; e.finishedAt = c.State.FinishedAt;
    let count = e.observedOom ?? 0;
    if (c.State.Running) {
      const observed = await oom(c);
      if (observed === undefined) return; // Exited between Docker inspect and /proc; inspect its final state next time.
      count = observed;
    }
    const exit = c.State.OOMKilled && c.State.FinishedAt !== e.lastOomExit;
    if (count > (e.observedOom ?? 0) || exit) {
      e.oomKills += count > (e.observedOom ?? 0) ? count - (e.observedOom ?? 0) : e.blockedAt === undefined ? 1 : 0;
      e.observedOom = count; if (exit) e.lastOomExit = c.State.FinishedAt;
      e.desiredRunning = false;
      e.blockedAt = now(); e.reason = "Workspace stopped after OOM. Park it, then explicitly unpark after 60 seconds to retry.";
      e.source = exit ? "workspace-container OOM exit" : "child-process cgroup OOM";
      await save(); // Persist the circuit breaker before any stop or restart operation.
      await markParked(idOf(c)!);
    }
    e.observedOom = count;
  }
  async function markParked(id: string) {
    if (options.park) return options.park(id);
    const directory = join("/data/app/workspaces", id, "metadata");
    // Persist the existing parked marker, which older app/System pairs also understand on rollback.
    const { existsSync } = await import("node:fs");
    if (!existsSync(join(directory, ".."))) return;
    await mkdir(directory, { recursive: true });
    const path = join(directory, "parked");
    await writeFile(path, "", { mode: 0o600 }); await chown(path, 1000, 1000);
  }
  async function stop(c: Container) { pending.delete(idOf(c)!); if (c.State.Running) await options.docker("stop", "--time", "3", c.Id); }
  const summary = () => ({ budget, aggregateMemory: options.memory, aggregateSwap: 0, defaults, totalWorkspaces: Object.keys(state ?? {}).length, workspaces: Object.fromEntries(Object.entries(state ?? {}).sort(([,a],[,b]) => (b.blockedAt ?? 0) - (a.blockedAt ?? 0)).slice(0,128)) });
  return {
    status() { return summary(); },
    shutdown() { closing = true; return serialize("resources", async () => {}); },
    reconcile(boot = false, restoreIds: readonly string[] = []) { return serialize("resources", async () => {
      if (closing) return { ...summary(), restore: [] };
      await load(); const before = JSON.stringify(state); const restore: string[] = []; const all = (await containers()).sort((a,b) => idOf(a)!.localeCompare(idOf(b)!)); let reserved = 0;
      for (const c of all) {
        const known = Object.hasOwn(state, idOf(c)!);
        const e = entry(c);
        const previousFinish = e.finishedAt;
        try { await observe(c,e); await apply(c,e); }
        catch (error) {
          e.reason = "Workspace stopped: resource control could not apply or verify its boundary.";
          console.error(e.reason, error); await save(); await markParked(idOf(c)!); await stop(c); continue;
        }
        if (e.blockedAt !== undefined) { e.desiredRunning = false; await stop(c); continue; }
        if (boot && !c.State.Running) {
          if (e.desiredRunning || (e.desiredRunning === undefined && restoreIds.includes(c.Id))) restore.push(c.Id);
          else if (!known || e.desiredRunning === false) { e.desiredRunning = false; e.reason = "Stopped workspace kept parked during recovery; explicit unpark is required."; await markParked(idOf(c)!); }
        } else if (!boot && !c.State.Running && e.desiredRunning && (!pending.has(idOf(c)!) || c.State.FinishedAt !== previousFinish)) {
          e.desiredRunning = false; e.reason = "Workspace kept parked after its container stopped; explicit unpark is required."; await markParked(idOf(c)!);
        }
        if (c.State.Running) {
          if (e.desiredRunning === false) { await markParked(idOf(c)!); await stop(c); continue; }
          if (reserved + e.limits.memory > budget) { e.desiredRunning = false; e.reason = "Workspace stopped: aggregate RAM admission budget is full. Park another workspace before retrying."; await markParked(idOf(c)!); await stop(c); }
          else { e.desiredRunning = true; reserved += e.limits.memory; pending.delete(idOf(c)!); }
        }
      }
      if (before !== JSON.stringify(state)) await save(); return { ...summary(), restore };
    }); },
    park(workspaceId: string) { return serialize("resources", async () => {
      await load(); const c = (await containers()).find(c => idOf(c) === workspaceId); if (!c) throw new Error("Workspace resource target not found");
      const e = entry(c); e.desiredRunning = false;
      if (e.blockedAt === undefined) e.reason = "Workspace is parked; explicit unpark is required.";
      pending.delete(workspaceId); await save(); await markParked(workspaceId); return null;
    }); },
    admit(workspaceId: string, recover = false) { return serialize("resources", async () => {
      if (closing) throw new Error("System resource control is stopping");
      await load(); const all = await containers(); const c = all.find(c => idOf(c) === workspaceId); if (!c) throw new Error("Workspace resource target not found");
      const e = entry(c); await observe(c,e);
      if (e.blockedAt !== undefined) {
        if (!recover || now() - e.blockedAt < 60_000) throw new Error(e.reason);
        delete e.blockedAt; delete e.reason;
      }
      if (e.desiredRunning === false && !recover) throw new Error("Workspace is parked; explicit unpark is required.");
      for (const [id, until] of pending) if (until <= now()) pending.delete(id);
      const reserved = all.filter(other => idOf(other) !== workspaceId && (other.State.Running || pending.has(idOf(other)!))).reduce((total, other) => total + entry(other).limits.memory, 0);
      if (reserved + e.limits.memory > budget) throw new Error("Workspace RAM admission budget is full. Park another workspace before starting this one.");
      await apply(c,e); e.desiredRunning = true; delete e.reason; await save(); pending.set(workspaceId, now() + 60_000);
      return null;
    }); },
  };
}
