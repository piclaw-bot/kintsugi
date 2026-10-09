import { createWorkspaceMetadataState } from "@agents-in-the-cloud/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { JsonValue } from "@agents-in-the-cloud/core";

const schema = Type.Array(Type.Object({ id: Type.String({ pattern: "^drawio-[a-zA-Z0-9-]+$" }), path: Type.String() }));
export type DiagramView = Static<typeof schema>[number];
export const views = createWorkspaceMetadataState("drawio-work-views.json", (value: JsonValue) => Value.Parse(schema, value), () => []);
export function createView(workspaceId: string, path = ""): DiagramView {
  const existing = views.read(workspaceId);
  const view = { id: `drawio-${crypto.randomUUID()}`, path };
  views.write(workspaceId, [...existing, view]);
  return view;
}
