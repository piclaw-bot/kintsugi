import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePrivateNetworkDestinations } from "./private-network.ts";
import { createWorkspaceNetworkControl } from "./workspace-network.ts";
import type { WorkspaceNetworkPolicy } from "../../../packages/shared/src/network-policy.ts";

const policy: WorkspaceNetworkPolicy = { mode: "hosts", cidrs: [], dns: ["192.168.1.53"], search: ["home.arpa"], resolver: "198.18.0.1", denied: ["192.168.1.1/32", "172.18.0.0/16"] };
const config = { cidrs: ["192.168.1.0/24"], dns: ["192.168.1.53"], search: ["home.arpa"] };

test("System resolves once per hostname and pins only permitted private addresses", async () => {
  let calls = 0;
  const resolved = await resolvePrivateNetworkDestinations([{ host: "db.internal", port: 22 }, { host: "db.internal", port: 5432 }], policy, async (_host, view) => {
    calls++; expect(view.resolver).toBe("198.18.0.1");
    return ["192.168.1.20", "192.168.1.1", "172.18.0.2", "127.0.0.1", "8.8.8.8"].map(address => ({ address, family: 4 }));
  });
  expect(calls).toBe(1);
  expect(resolved.map(entry => entry.addresses)).toEqual([["192.168.1.20"], ["192.168.1.20"]]);
  await expect(resolvePrivateNetworkDestinations([{ host: "db.internal", port: 22 }], policy, async () => [{ address: "192.168.1.1", family: 4 }])).rejects.toThrow("no permitted private addresses");
  await expect(resolvePrivateNetworkDestinations([{ host: "db.internal", port: 22 }], policy, async () => { throw new Error("DNS unavailable"); })).rejects.toThrow("DNS unavailable");
  await expect(resolvePrivateNetworkDestinations([], { ...policy, mode: "off" })).rejects.toThrow("require listed-host mode");
});

test("listed-host apply stages DNS, installs a narrow snapshot and restores the prior policy after failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "system-hosts-policy-"));
  const file = join(dir, "policies.json");
  const installed: Array<Array<{ bridge: string; policy: WorkspaceNetworkPolicy }>> = [];
  let fail = false;
  try {
    const control = await createWorkspaceNetworkControl("/system/build", file, {
      destinations: async () => [...policy.denied],
      install: async (_group, _dns, networks = []) => { installed.push(structuredClone(networks)); },
      resolvers: async () => {},
      resolve: (entries, view) => resolvePrivateNetworkDestinations(entries, view, async () => { if (fail) throw new Error("DNS unavailable"); return [{ address: "192.168.1.20", family: 4 }]; }),
    });
    const applied = await control({ workspaceId: "hosts001", mode: "hosts", configuration: config, destinations: [{ host: "db.internal", port: 5432 }] });
    expect(applied).toMatchObject({ mode: "hosts", cidrs: [], destinations: [{ host: "db.internal", port: 5432, addresses: ["192.168.1.20"] }] });
    expect(applied.resolver).toBeDefined();
    expect(installed.at(-2)![0]!.policy.destinations).toBeUndefined();
    expect(installed.at(-1)![0]!.policy.destinations).toEqual(applied.destinations);
    const before = await readFile(file, "utf8");
    fail = true;
    await expect(control({ workspaceId: "hosts001", mode: "hosts", configuration: config, destinations: [{ host: "other.internal", port: 22 }] })).rejects.toThrow("DNS unavailable");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(installed.at(-1)![0]!.policy.destinations).toEqual(applied.destinations);
    expect((await control({ workspaceId: "hosts001", mode: "off", configuration: config })).destinations).toBeUndefined();
    await expect(control({ workspaceId: "hosts001", mode: "off", configuration: config, destinations: [{ host: "db.internal", port: 22 }] })).rejects.toThrow("require listed-host mode");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
