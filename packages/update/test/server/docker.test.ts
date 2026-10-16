import { expect, test } from "bun:test";
import { prepareUpdate } from "../../src/server/docker.ts";

test("resource-reader incompatibility is rejected before prune, pull or alias changes", async () => {
  const calls: string[] = [];
  await expect(prepareUpdate("ghcr.io/example/app:old", () => {}, {
    readResourceStateVersion: async () => 1,
    resolve: async reference => ({ reference, requiredSystemVersion: 0, resourcePolicyVersion: 0, layers: [], dependencies: [] }),
    pull: async () => { calls.push("pull"); },
    prune: async () => { calls.push("prune"); },
  })).rejects.toThrow("resource-aware");
  expect(calls).toEqual([]);
});
