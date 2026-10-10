import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestApp, postJson, temporaryKintsugiDataDir } from "./support/test-web-app.ts";
import { defaultAgentType } from "../src/server/agent-types.ts";

const data = temporaryKintsugiDataDir();
beforeEach(data.setUp);
afterEach(data.tearDown);

test.each(["codex", "codex-cli"])("%s workspace creation requires its subscription before provisioning", async agentTypeId => {
  let provisioned = false;
  const { app, registry } = createTestApp({ provision: async () => { provisioned = true; } });
  const response = await app.fetch(postJson("/workspaces", { agent: { agentTypeId, initialPrompt: "Do not run without authentication" } }));
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatchObject({ code: "agent_setup_required", setupUrl: "/models?connect=openai-codex" });
  expect(provisioned).toBe(false);
  expect(registry.list()).toHaveLength(0);
  expect((await defaultAgentType()).id).toBe("builtin");
});

test.each(["codex", "codex-cli"])("adding a %s tab requires authentication without changing the default", async agentTypeId => {
  const { app, registry } = createTestApp();
  await registry.seed([{ id: "codex-auth-test", title: "Codex auth" }]);
  const response = await app.fetch(postJson(`/workspaces/codex-auth-test/commands/agent.create.${agentTypeId}`, {}));
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("agent_setup_required");
  expect((await defaultAgentType()).id).toBe("builtin");
});
