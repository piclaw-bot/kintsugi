import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { openDurableWorkspace } from "../../src/server/durable-workspace.ts";
import { createLegacyBashOperation, type BashOperations } from "../../src/server/legacy-bash-operation.ts";

const context = BACKGROUND_CONTEXT;
const request = { id: "legacy-command", command: "must not replay", deadline: 1, cwd: "/work", env: {} };
const done = { status: "done", exitCode: 0, aborted: false, timedOut: false, output: "old output", displayAnsi: "old output", fullOutputPath: "/tmp/old-output" } as const;

for (const stop of [false, true]) {
  test(`a persisted receipt operation ${stop ? "stops" : "recovers"} through its original backend, not terminal processes`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "legacy-bash-recovery-"));
    const calls: {action: string; create: boolean}[] = [];
    const entered = Promise.withResolvers<void>();
    let recovered = false;
    const operations: BashOperations = async (action, _request, create = false) => {
      calls.push({action, create});
      if (!recovered) { entered.resolve(); return {status: "running", session: "old-session"}; }
      return action === "stop" ? {...done, aborted: true} : done;
    };
    const operation = createLegacyBashOperation("workspace", operations);
    const registry = createRegistry();
    registry.install(defineExtension({name: "test.legacy-bash", tasks: [operation]}));
    const options = {models: createModels(), registry};
    let workspace = await openDurableWorkspace(directory, "workspace", options);
    try {
      const conversation = await workspace.agent({agentId: "tab", label: "Agent", title: "Legacy bash"});
      const task = await workspace.harness.commit(tx => tx.createTask(operation, {request, timeout: 1}, {conversationId: conversation.id, ownership: {kind: "conversation"}}), context);
      workspace.harness.resume();
      await entered.promise;
      await workspace.close();
      recovered = true;
      workspace = await openDurableWorkspace(directory, "workspace", options);
      if (stop) await workspace.harness.abortTask(task, context);
      const settled = await workspace.harness.waitForTask(task, context);
      expect(settled.state.outcome.status).toBe(stop ? "aborted" : "completed");
      expect(calls).toEqual([{action: "ensure", create: true}, {action: stop ? "stop" : "ensure", create: false}]);
      expect(operation.definition.name).toBe("kintsugi.bash-operation");
      expect(operation.definition.version).toBe(1);
    } finally { await workspace.close(); await rm(directory, {recursive: true, force: true}); }
  });
}
