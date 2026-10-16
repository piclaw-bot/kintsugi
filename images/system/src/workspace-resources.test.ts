import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceResourceControl, workspaceResourceDefaults } from "./workspace-resources.ts";
const GiB = 1024 ** 3;
function container(id: string, memory = 0) { return { Id: id, Name: `/kintsugi-${id}`, Config: { Labels: { "com.kintsugi.type": "workspace", "com.kintsugi.workspace-id": id } }, State: { Running: false, OOMKilled: false, Pid: 100, ExitCode: 0, FinishedAt: "" }, RestartCount: 0, HostConfig: { Memory: memory, MemorySwap: memory, NanoCpus: 0, PidsLimit: 0 } }; }
async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(); try { await body(f); } finally { await rm(f.directory, { recursive: true, force: true }); }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-resource-control-")); const file = join(directory, "state.json");
  const containers = [container("a"),container("b"),container("c"),container("d")];
  let time = 1000; const kills = new Map<string,number>(); const parked: string[] = []; const calls: string[][] = [];
  async function docker(...args: string[]) {
    calls.push(args);
    if (args[0] === "ps") return containers.map(c => c.Id).join("\n");
    if (args[0] === "inspect") return JSON.stringify(containers);
    const c = containers.find(c => c.Id === args.at(-1))!;
    if (args[0] === "stop") { c.State.Running = false; return c.Id; }
    if (args[0] === "update") { c.HostConfig.Memory = Number(args[args.indexOf("--memory")+1]); c.HostConfig.MemorySwap = Number(args[args.indexOf("--memory-swap")+1]); c.HostConfig.NanoCpus = Number(args[args.indexOf("--cpus")+1])*1e9; c.HostConfig.PidsLimit = Number(args[args.indexOf("--pids-limit")+1]); return c.Id; }
    throw Error("Unexpected Docker operation");
  }
  const create = () => createWorkspaceResourceControl({ memory: 8*GiB, cpus: 6, cgroupParent: "/fixture/workloads", file, docker, now: () => time, readOom: async c => kills.get(c.Id) ?? 0, park: async id => { parked.push(id); } });
  return { directory, file, containers, calls, kills, parked, create, advance: (ms: number) => { time += ms; } };
}
test("workspace defaults bound memory, CPU and processes on small and large installations", () => {
  expect(workspaceResourceDefaults(2*GiB,1)).toEqual({ memory: GiB, cpus: 1, pids: 1024 });
  expect(workspaceResourceDefaults(64*GiB,64)).toEqual({ memory: 2*GiB, cpus: 4, pids: 1024 });
});
test("concurrent admission reserves RAM before Docker starts containers", () => fixture(async f => {
  const control = f.create();
  expect((await Promise.allSettled(["a","b","c","d"].map(id => control.admit(id)))).map(r=>r.status)).toEqual(["fulfilled","fulfilled","fulfilled","rejected"]);
  expect(f.calls.filter(c=>c[0]==="update").every(c=>c.includes("no")&&c.includes("128"))).toBe(true);
}));
test("restoration parks excess workloads and preserves management/build headroom", () => fixture(async f => {
  f.containers.forEach(c=>{c.State.Running=true;}); const result=await f.create().reconcile();
  expect(f.containers.filter(c=>c.State.Running)).toHaveLength(3); expect(f.parked).toContain("d"); expect(result.budget).toBe(Math.floor(8*GiB*.8));
}));
test("a child OOM trips durable containment without restarting the app or unrelated workspace", () => fixture(async f => {
  f.containers[0]!.State.Running=true;f.containers[1]!.State.Running=true;
  const control=f.create();await control.reconcile();f.kills.set("a",1);await control.reconcile();
  expect(f.containers[0]!.State.Running).toBe(false);expect(f.containers[1]!.State.Running).toBe(true);expect(f.parked).toContain("a");
  const state=JSON.parse(await readFile(f.file,"utf8"));expect(state.a.source).toBe("child-process cgroup OOM");expect(state.a.oomKills).toBe(1);
  const restored=f.create();await expect(restored.admit("a")).rejects.toThrow("OOM");
  await expect(restored.admit("a",true)).rejects.toThrow("OOM");f.advance(60_001);
  await expect(restored.admit("a")).rejects.toThrow("OOM");await restored.admit("a",true);
}));
test("PID 1 OOM exits stay blocked across replacement and explicit retry has a cooldown", () => fixture(async f => {
  const c=f.containers[0]!;c.State.OOMKilled=true;c.State.ExitCode=137;c.State.FinishedAt="2026-10-16T19:00:00Z";
  const control=f.create();await control.reconcile();expect(control.status().workspaces.a!.source).toBe("workspace-container OOM exit");
  f.containers[0]={...c,Id:"new-a",State:{...c.State,OOMKilled:false}};
  await expect(f.create().admit("a")).rejects.toThrow("OOM");
}));
test("nonzero operator limits survive controller restart, container recreation and future Docker changes", () => fixture(async f => {
  const c=f.containers[0]!;c.HostConfig.Memory=GiB;c.HostConfig.MemorySwap=GiB;c.HostConfig.NanoCpus=1e9;c.HostConfig.PidsLimit=256;
  await f.create().reconcile();f.containers[0]=container("a");f.containers[0]!.Id="replacement-a";
  await f.create().admit("a");expect(f.containers[0]!.HostConfig.Memory).toBe(GiB);expect(f.containers[0]!.HostConfig.NanoCpus).toBe(1e9);
  f.containers[0]!.HostConfig.Memory=512*1024**2;f.containers[0]!.HostConfig.MemorySwap=512*1024**2;
  await f.create().reconcile();
  expect(JSON.parse(await readFile(f.file,"utf8")).a.limits.memory).toBe(512*1024**2);
}));
test("diagnostics omit Docker commands/environment and retain only bounded structured runtime metadata", () => fixture(async f => {
  Object.assign(f.containers[0]!.Config,{Env:["TOKEN=do-not-report"],Cmd:["secret-command"]});
  const control=f.create();await control.reconcile();const report=JSON.stringify(control.status());expect(report).not.toContain("do-not-report");expect(report).not.toContain("secret-command");
}));

test("boot recovery leaves previously stopped containers parked rather than starting them", () => fixture(async f => {
  const result=await f.create().reconcile(true);
  expect(result.restore).toEqual([]);expect(f.parked).toEqual(["a","b","c","d"]);
  expect(f.calls.some(c=>c[0]==="start")).toBe(false);
}));
test("healthy running intent survives a hard restart, but a later operator stop clears it", () => fixture(async f => {
  f.containers[0]!.State.Running=true;const control=f.create();await control.reconcile();
  f.containers[0]!.State.Running=false;
  expect((await f.create().reconcile(true)).restore).toContain("a");
  await control.reconcile();expect(f.parked).toContain("a");
  expect((await f.create().reconcile(true)).restore).not.toContain("a");
}));

test("shutdown drains the observer without turning a service stop into a parked workspace", () => fixture(async f => {
  f.containers[0]!.State.Running=true;const control=f.create();await control.reconcile();await control.shutdown();
  f.containers[0]!.State.Running=false;await control.reconcile();expect(f.parked).not.toContain("a");
  await expect(control.admit("a")).rejects.toThrow("stopping");
  expect((await f.create().reconcile(true)).restore).toContain("a");
}));

test("explicit parking blocks attention-driven or stale-restore relaunches until explicit unpark", () => fixture(async f => {
  const control=f.create();await control.park("a");
  await expect(control.admit("a")).rejects.toThrow("explicit unpark");
  expect((await f.create().reconcile(true,["a"])).restore).not.toContain("a");
  f.containers[0]!.State.Running=true;await control.reconcile();expect(f.containers[0]!.State.Running).toBe(false);
  await control.admit("a",true);
}));
