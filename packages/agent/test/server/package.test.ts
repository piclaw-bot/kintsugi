import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as agent from "../../src/server/index.ts";
import manifest from "../../package.json";

describe("shared agent package", () => {
  test("provides shared support without registering an agent type", () => {
    expect(agent.agentWorkspaceModule.id).toBe("agent");
    expect(agent.agentWorkspaceModule.agentType).toBeUndefined();
    expect(agent.agentWorkspaceModule.cableChannels?.map(channel => channel.name)).toEqual(["agent-plan"]);
    expect("durableWorkspaceOwner" in agent).toBe(false);
    expect("nativeAgentLaunch" in agent).toBe(false);
    expect("configureAgentDelegation" in agent).toBe(false);
  });

  test("does not depend on the builtin package or its durable execution libraries", async () => {
    const forbidden = ["@kintsugi/builtin-agent", "@earendil-works/pi-durable", "@earendil-works/chord"];
    for (const dependency of forbidden) expect(dependency in manifest.dependencies).toBe(false);
    const sourceDirectory = join(import.meta.dir, "../../src");
    for (const file of new Bun.Glob("**/*.ts").scanSync(sourceDirectory)) {
      const source = await Bun.file(join(sourceDirectory, file)).text();
      for (const dependency of forbidden) expect(source.includes(dependency)).toBe(false);
    }
  });
});
