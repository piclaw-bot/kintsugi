import { KintsugiCoreError, createKeyedOperationQueue, type KintsugiEventBus, type JsonValue } from "@kintsugi/core";
import { createWorkspaceMetadataState } from "@kintsugi/workspace";
import { revokeAgentMcp } from "@kintsugi/agent/server";
import type { createLivePresentation, WorkspaceAgentInput } from "@kintsugi/shared";
import type { CliModelSettings, createCliModelSettings } from "@kintsugi/cli-agent/server";

export interface NativeAgentRecord { id: string; title: string; model?: string; thinkingLevel?: string }

/** A harness that runs in the workspace and renders into Kintsugi's own transcript and composer. */
export interface NativeAgentRuntime {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly record: NativeAgentRecord;
  readonly state: { readonly notices: readonly string[] };
  readonly failure?: Error;
  readonly isBusy: boolean;
  /** Waits for a connecting harness. */
  systemPrompt(): Promise<string>;
  readonly completionCatalog: string;
  readonly presentation: ReturnType<typeof createLivePresentation>;
  refreshCompletionCatalog(): Promise<void>;
  reconnect(): Promise<void>;
  send(input: WorkspaceAgentInput, requestId: string): Promise<void>;
  stop(): Promise<void>;
  configure(parameters: { model?: string; thinkingLevel?: string }): Promise<void>;
  rename(title: string): Promise<void>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

/** Each workspace keeps its native Agents of one type in one metadata file. */
export function createNativeAgentStore<Record extends NativeAgentRecord>(filename: string, label: string, parse: (value: JsonValue) => Record[]) {
  const metadata = createWorkspaceMetadataState(filename, value => ({ agents: parse(value) }), () => ({ agents: [] }));
  const list = (workspaceId: string) => metadata.read(workspaceId).agents;
  return {
    list,
    get(workspaceId: string, id: string) {
      const record = list(workspaceId).find(record => record.id === id);
      if (!record) throw new KintsugiCoreError("agent_not_found", `${label} Agent not found: ${id}`);
      return record;
    },
    save(workspaceId: string) { metadata.write(workspaceId, { agents: list(workspaceId) }); },
    add(workspaceId: string, record: Record) { metadata.write(workspaceId, { agents: [...list(workspaceId), record] }); },
    remove(workspaceId: string, id: string) { metadata.write(workspaceId, { agents: list(workspaceId).filter(record => record.id !== id) }); },
  };
}
export type NativeAgentStore<Record extends NativeAgentRecord> = ReturnType<typeof createNativeAgentStore<Record>>;

/** One connected runtime per Agent, opened on first use and reconnected after a failure. */
export function createNativeAgents<Record extends NativeAgentRecord, Runtime extends NativeAgentRuntime>(options: {
  store: () => NativeAgentStore<Record>;
  settings: Pick<ReturnType<typeof createCliModelSettings>, "prepare">;
  newRecord(selected: CliModelSettings): Record;
  open(workspaceId: string, record: Record, save: () => void, events: KintsugiEventBus): Promise<Runtime>;
  activate?(runtime: Runtime): Promise<void>;
}, getEvents: () => KintsugiEventBus) {
  let metadata: NativeAgentStore<Record> | undefined;
  const store = () => metadata ??= options.store();
  const runtimes = new Map<string, Promise<Runtime>>();
  const serialize = createKeyedOperationQueue();
  async function ready(workspaceId: string, agentId: string) {
    const record = store().get(workspaceId, agentId);
    let runtime = runtimes.get(agentId);
    if (!runtime) {
      runtime = options.open(workspaceId, record, () => store().save(workspaceId), getEvents());
      runtimes.set(agentId, runtime);
      void runtime.catch(() => { if (runtimes.get(agentId) === runtime) runtimes.delete(agentId); });
    }
    const opened = await runtime;
    if (opened.failure) await opened.reconnect();
    return opened;
  }
  async function create(workspaceId: string, parameters: { model?: string; thinkingLevel?: string; input?: WorkspaceAgentInput } = {}) {
    return serialize(workspaceId, async () => {
      const record = options.newRecord(await options.settings.prepare({ model: parameters.model ?? "", thinkingLevel: parameters.thinkingLevel ?? "" }));
      store().add(workspaceId, record);
      const runtime = await ready(workspaceId, record.id);
      await options.activate?.(runtime);
      const input = parameters.input;
      if (input && (input.text.trim() || input.images.length || input.attachmentNotes.length)) await runtime.send(input, `launch-${record.id}`);
      return record.id;
    });
  }
  async function close(workspaceId: string, agentId: string) {
    return serialize(workspaceId, async () => {
      store().get(workspaceId, agentId);
      const runtime = runtimes.get(agentId);
      if (runtime) await (await runtime).close();
      runtimes.delete(agentId);
      await revokeAgentMcp(workspaceId, agentId);
      store().remove(workspaceId, agentId);
    });
  }
  async function disposeWorkspace(workspaceId: string) {
    for (const record of store().list(workspaceId)) {
      const runtime = runtimes.get(record.id);
      if (runtime) { await (await runtime).dispose(); runtimes.delete(record.id); }
      await revokeAgentMcp(workspaceId, record.id);
    }
  }
  async function disposeAll() {
    await Promise.all([...runtimes.values()].map(async runtime => (await runtime).dispose()));
    runtimes.clear();
  }
  return { list: (workspaceId: string) => store().list(workspaceId), ready, create, close, disposeWorkspace, disposeAll };
}
export type NativeAgents<Runtime extends NativeAgentRuntime> = ReturnType<typeof createNativeAgents<NativeAgentRecord, Runtime>>;
