import { expect, test } from "bun:test";
import type { WorkspaceAgentType, WorkspaceAgentTabSummary } from "@kintsugi/shared";
import { createAgentPaneHost } from "../src/server/agent-pane-host.ts";

function occupant(id: string, initial: WorkspaceAgentTabSummary[]) {
  let agents = initial;
  const closed: string[] = [];
  const agentType: WorkspaceAgentType = {
    id, label: id, iconHtml: id,
    tabs: {
      list: async () => agents,
      render: async ({ agentId }) => `${id}/${agentId}`,
      close: async ({ agentId }) => {
        closed.push(agentId);
        agents = agents.filter((agent) => agent.id !== agentId);
      },
    },
    async create() { throw new Error("Listing must not create an agent"); },
    launch: {
      async renderFooter() { return ""; }, async prepare() { return undefined; },
      async submit() { throw new Error("not used"); }, async prepareWorkspace() { throw new Error("Listing must not prepare a workspace"); },
    },
  };
  return { agentType, closed };
}

test("empty panes stay empty without preparing a default", async () => {
  const host = createAgentPaneHost([occupant("builtin", []).agentType, occupant("codex", []).agentType]);
  expect(await host.list({ workspaceId: "workspace" })).toEqual([]);
  expect(await host.list({ workspaceId: "workspace" })).toEqual([]);
});

test("mixed Agent types expose ownership and route rendering and closure", async () => {
  const builtin = occupant("builtin", [{ id: "first", title: "First" }]);
  const codex = occupant("codex", [{ id: "second", title: "Second" }, { id: "third", title: "Third" }]);
  const host = createAgentPaneHost([builtin.agentType, codex.agentType]);
  expect((await host.list({ workspaceId: "workspace" })).map(({ id, agentTypeId }) => ({ id, agentTypeId }))).toEqual([
    { id: "first", agentTypeId: "builtin" }, { id: "second", agentTypeId: "codex" }, { id: "third", agentTypeId: "codex" },
  ]);
  expect(await host.render({ workspaceId: "workspace", agentId: "second" })).toBe("codex/second");
  await host.close({ workspaceId: "workspace", agentId: "second" });
  expect(codex.closed).toEqual(["second"]);
  expect(builtin.closed).toEqual([]);
});

test("concurrent closures may close the last tab and retain the empty state", async () => {
  const { agentType, closed } = occupant("builtin", [{ id: "first", title: "First" }, { id: "second", title: "Second" }]);
  const host = createAgentPaneHost([agentType]);
  await Promise.all([host.close({ workspaceId: "workspace", agentId: "first" }), host.close({ workspaceId: "workspace", agentId: "second" })]);
  expect(closed).toEqual(["first", "second"]);
  expect(await host.list({ workspaceId: "workspace" })).toEqual([]);
});

test("unknown identities do not reach an Agent type", async () => {
  const { agentType, closed } = occupant("builtin", [{ id: "existing", title: "Existing" }]);
  const host = createAgentPaneHost([agentType]);
  await expect(host.close({ workspaceId: "workspace", agentId: "missing" })).rejects.toMatchObject({ code: "agent_not_found" });
  expect(closed).toEqual([]);
});

test("ambiguous Agent type and Agent identities fail explicitly", async () => {
  const a = occupant("a", [{ id: "same", title: "A" }]).agentType;
  const b = occupant("b", [{ id: "same", title: "B" }]).agentType;
  expect(() => createAgentPaneHost([a, a])).toThrow("Duplicate agent type identity");
  await expect(createAgentPaneHost([a, b]).list({ workspaceId: "workspace" })).rejects.toThrow("Duplicate agent identity");
});
