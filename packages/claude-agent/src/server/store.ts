import { createNativeAgentStore } from "@kintsugi/native-agent/server";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { label } from "./setup.ts";

const schema = Type.Object({ agents: Type.Array(Type.Object({
  id: Type.String(), title: Type.String(), sessionId: Type.String(),
  // Claude records a fork under its new session ID only once it has a message of its own.
  forkedFrom: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()),
  submissions: Type.Array(Type.Object({ id: Type.String(), digest: Type.String() })),
  // Switching conversations records its outcome with the switch, so a retried request replays it.
  commandSubmissions: Type.Optional(Type.Array(Type.Object({ id: Type.String(), digest: Type.String(), message: Type.String() }))),
})) });
export type ClaudeAgentRecord = Static<typeof schema>["agents"][number];
/** The Claude Code CLI agent keeps claude-agents.json from before this agent existed. */
export const createClaudeStore = () => createNativeAgentStore("claude-code-agents.json", label, value => Value.Parse(schema, value).agents);
