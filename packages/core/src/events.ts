export interface AgentSystemPromptPrepareEvent {
  workspaceId: string;
  agentId: string;
  lines: string[];
}

export interface KintsugiHostStartedEvent {
  workspaces: Array<{ id: string; parked: boolean }>;
}

export interface KintsugiEventMap {
  agent_system_prompt_prepare: AgentSystemPromptPrepareEvent;
  kintsugi_host_stopping: Record<string, never>;
  kintsugi_host_started: KintsugiHostStartedEvent;
}

export type KintsugiEventHandler<K extends keyof KintsugiEventMap> = (event: KintsugiEventMap[K]) => void | Promise<void>;

export interface KintsugiEventBus {
  on<K extends keyof KintsugiEventMap>(eventName: K, handler: KintsugiEventHandler<K>): () => void;
  emit<K extends keyof KintsugiEventMap>(eventName: K, event: KintsugiEventMap[K]): Promise<void>;
}

export function createKintsugiEventBus(): KintsugiEventBus {
  const handlers = new Map<keyof KintsugiEventMap, Set<KintsugiEventHandler<any>>>();

  return {
    on(eventName, handler) {
      const eventHandlers = handlers.get(eventName) ?? new Set<KintsugiEventHandler<typeof eventName>>();
      handlers.set(eventName, eventHandlers);
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },

    async emit(eventName, event) {
      const eventHandlers = handlers.get(eventName);
      if (!eventHandlers) return;
      for (const handler of eventHandlers) {
        await handler(event);
      }
    },
  };
}
