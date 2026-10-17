import { expect, test } from "bun:test";

// Isolate module mocks from the real repository tests in the same suite.
test("workspace attachment and unopened turn completion do not capture Changes", async () => {
  const script = `
    import { mock } from "bun:test";
    import * as git from "@kintsugi/workspace/git";
    let repositoryCalls = 0;
    mock.module("@kintsugi/workspace/git", () => ({ ...git, workspaceRepository() {
      repositoryCalls++;
      throw new Error("repository capture requested");
    } }));
    const { kintsugiServerModule: module } = await import("./packages/changes/src/server/index.ts");
    const handlers = new Map();
    module.initialize({
      invalidateWorkspace() {},
      events: { on(name, handler) { handlers.set(name, handler); } },
      onWorkspaceRemoved() {},
    });
    await module.attachToWorkspace({ workspaceId: "slow-repository", init: { type: "existing" } });
    await handlers.get("workspace_agent_turn_finished")({ workspaceId: "slow-repository" });
    if (repositoryCalls !== 0) throw new Error("Closed Changes captured a repository");
    // An explicit view request still performs the real capture instead of hiding its failure.
    try {
      await module.workViews[0].render({ workspaceId: "slow-repository", reference: { type: "changes" } });
      throw new Error("Expected the explicit capture failure");
    } catch (error) {
      if (error.message !== "repository capture requested") throw error;
    }
    if (repositoryCalls !== 1) throw new Error("Explicit Changes request did not capture once");
  `;
  const process = Bun.spawn(["bun", "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
