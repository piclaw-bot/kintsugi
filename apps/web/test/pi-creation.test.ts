import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestApp, postJson, temporaryKintsugiDataDir } from "./support/test-web-app.ts";
import { defaultAgentType } from "../src/server/agent-types.ts";

const data = temporaryKintsugiDataDir();
beforeEach(data.setUp);
afterEach(data.tearDown);

test("Pi workspace creation requires a connected enabled model before provisioning", async () => {
  let provisioned = false;
  const { app, registry } = createTestApp({ provision: async () => { provisioned = true; } });
  const response = await app.fetch(postJson("/workspaces", { agent: { agentTypeId: "pi", initialPrompt: "Do not run without authentication" } }));
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatchObject({ code: "agent_setup_required", setupUrl: "/models?focus=models" });
  expect(provisioned).toBe(false);
  expect(registry.list()).toHaveLength(0);
  expect((await defaultAgentType()).id).toBe("builtin");
});

test("adding a Pi tab requires authentication without changing the default", async () => {
  const { app, registry } = createTestApp();
  await registry.seed([{ id: "pi-auth-test", title: "Pi auth" }]);
  const response = await app.fetch(postJson("/workspaces/pi-auth-test/commands/agent.create.pi", {}));
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("agent_setup_required");
  expect((await defaultAgentType()).id).toBe("builtin");
});
