import { createNativeAgentStore } from "@kintsugi/native-agent/server";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { label } from "./setup.ts";

const schema = Type.Object({ agents: Type.Array(Type.Object({
  id: Type.String(), title: Type.String(), threadId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()),
  commandSubmissions: Type.Optional(Type.Array(Type.Object({ id: Type.String(), digest: Type.String(), result: Type.Optional(Type.String()) }))),
  submissions: Type.Array(Type.Object({ id: Type.String(), digest: Type.String(), accepted: Type.Boolean() })),
})) });
export type CodexAgentRecord = Static<typeof schema>["agents"][number];
export const createCodexStore = () => createNativeAgentStore("codex-agents.json", label, value => Value.Parse(schema, value).agents);
