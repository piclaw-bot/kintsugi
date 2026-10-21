import type { Models } from "@earendil-works/pi-ai";
import type { ConversationView, Extension, Harness } from "@earendil-works/pi-durable";
import type { BackgroundActivity } from "@kintsugi/agent/server/background-activity";
import type { AgentTranscriptSnapshot } from "@kintsugi/agent/server/transcript-contributions";

/** Work an integration lists in a root Agent's Background bar, each opening as its own page. */
export interface BackgroundActivitySource {
  /** The root Agent's activities. */
  activities(workspaceId: string, rootId: string): Promise<BackgroundActivity[]>;
  /** Watches what its activities depend on beyond the agent catalog and the task graph; resolves to stopping them. */
  watch?(harness: Harness, changed: () => void): Promise<() => Promise<void>>;
  /** What an activity's page shows beneath its header, such as a child agent's live transcript. */
  detail(workspaceId: string, rootId: string, activity: BackgroundActivity): Promise<string>;
  /** Stops a running activity. */
  stop(workspaceId: string, activity: BackgroundActivity): Promise<void>;
}

/**
 * A feature that extends every workspace's Builtin Agents: tools in their registry, what it adds to their
 * transcripts, and the work it lists in their Background bars. Registered when its module initializes, before any
 * workspace owner opens.
 */
export interface BuiltinAgentIntegration {
  id: string;
  /** Installed in each workspace's registry, so its tools and tasks also recover after a restart. */
  extension?(workspaceId: string, models: Models): Extension;
  /** Declarative additions to a conversation's transcript. */
  transcript?(view: ConversationView): Partial<AgentTranscriptSnapshot>;
  background?: BackgroundActivitySource;
}

const integrations: BuiltinAgentIntegration[] = [];

/** Resolves to unregistering it. */
export function registerBuiltinAgentIntegration(integration: BuiltinAgentIntegration): () => void {
  if (integrations.some(item => item.id === integration.id)) throw new Error(`Builtin Agent integration already registered: ${integration.id}`);
  integrations.push(integration);
  return () => { integrations.splice(integrations.indexOf(integration), 1); };
}

export function builtinAgentIntegrations(): readonly BuiltinAgentIntegration[] {
  return integrations;
}

/** Every integration's transcript additions for a conversation, as one snapshot. */
export function integrationTranscript(view: ConversationView): AgentTranscriptSnapshot | undefined {
  const parts = integrations.flatMap(integration => integration.transcript ? [integration.transcript(view)] : []);
  if (!parts.length) return undefined;
  return {
    rows: parts.flatMap(part => part.rows ?? []),
    anchors: parts.flatMap(part => part.anchors ?? []),
    nested: parts.flatMap(part => part.nested ?? []),
    inheritedContext: parts.find(part => part.inheritedContext)?.inheritedContext,
  };
}
