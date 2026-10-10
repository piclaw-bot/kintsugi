import { createWorkspaceMetadataState } from "@kintsugi/workspace";
import { KintsugiCoreError } from "@kintsugi/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const schema = Type.Object({ agents: Type.Array(Type.Object({
  id: Type.String(), title: Type.String(), threadId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()),
  commandSubmissions: Type.Optional(Type.Array(Type.Object({ id: Type.String(), digest: Type.String(), result: Type.Optional(Type.String()) }))),
  submissions: Type.Array(Type.Object({ id: Type.String(), digest: Type.String(), accepted: Type.Boolean() })),
})) });
export type CodexAgentRecord = Static<typeof schema>["agents"][number];
export function createCodexStore() {
  const metadata = createWorkspaceMetadataState("codex-agents.json", value => Value.Parse(schema, value), () => ({ agents: [] }));
  const list = (workspaceId: string) => metadata.read(workspaceId).agents;
  return {
    list,
    get(workspaceId: string, id: string) {
      const record = list(workspaceId).find(record => record.id === id);
      if (!record) throw new KintsugiCoreError("agent_not_found", `Codex Agent not found: ${id}`);
      return record;
    },
    save(workspaceId: string) { metadata.write(workspaceId, { agents: list(workspaceId) }); },
    add(workspaceId: string, record: CodexAgentRecord) { metadata.write(workspaceId, { agents: [...list(workspaceId), record] }); },
    remove(workspaceId: string, id: string) { metadata.write(workspaceId, { agents: list(workspaceId).filter(record => record.id !== id) }); },
  };
}
