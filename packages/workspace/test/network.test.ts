import { expect, test } from "bun:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceMetadataState } from "../src/metadata-state.ts";
import { getNetworkConfiguration, setNetworkConfiguration, getWorkspaceNetworkMode, setWorkspaceNetworkMode, getAppliedWorkspaceNetwork, workspaceNetworkRestartRequired, writeWorkspaceNetworkBootstrap } from "../src/network.ts";
import { workspaceNetworkAddressAllowed, type WorkspaceNetworkPolicy } from "@kintsugi/shared/network-policy";

const config = { cidrs: ["192.168.10.0/24", "fd12:3456::/64"], dns: ["192.168.20.53"], search: ["home.arpa"] };
test("persistent settings are off by default and edits do not grant runtime access", async () => {
  await setNetworkConfiguration(config);
  const id = "network-desired";
  expect(getWorkspaceNetworkMode(id)).toBe("off");
  expect(await workspaceNetworkRestartRequired(id)).toBe(false);
  await setWorkspaceNetworkMode(id, "lan");
  expect(getWorkspaceNetworkMode(id)).toBe("lan");
  expect(getAppliedWorkspaceNetwork(id).mode).toBe("off");
  expect(workspaceNetworkAddressAllowed("192.168.10.20", getAppliedWorkspaceNetwork(id))).toBe(false);
  expect(await workspaceNetworkRestartRequired(id)).toBe(true);
  await setWorkspaceNetworkMode(id, "off");
  expect(await workspaceNetworkRestartRequired(id)).toBe(false);
});
test("applied snapshots survive recovery and global edits require restart", async () => {
  await setNetworkConfiguration(config);
  const id = "network-applied";
  const applied: WorkspaceNetworkPolicy = { mode: "lan", ...config, resolver: "198.18.0.1", denied: ["172.18.0.0/16"] };
  // A replacement app process starts from this persisted snapshot, not settings.
  const store = createWorkspaceMetadataState<{ mode: "lan"; applied: WorkspaceNetworkPolicy }>("network.json", () => ({ mode: "lan", applied }), () => ({ mode: "lan", applied }));
  store.write(id, { mode: "lan", applied });
  expect(getAppliedWorkspaceNetwork(id)).toEqual(applied);
  expect(await workspaceNetworkRestartRequired(id)).toBe(false);
  await setNetworkConfiguration({ ...config, dns: ["192.168.20.54"] });
  expect((await getNetworkConfiguration()).dns).toEqual(["192.168.20.54"]);
  expect(getAppliedWorkspaceNetwork(id).dns).toEqual(["192.168.20.53"]);
  expect(await workspaceNetworkRestartRequired(id)).toBe(true);
  await setWorkspaceNetworkMode(id, "off");
  expect(getAppliedWorkspaceNetwork(id).mode).toBe("lan");
  expect(await workspaceNetworkRestartRequired(id)).toBe(true);
});
test("DNS startup configuration runs before init and can be disabled without changing user files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "network-dns-unit-"));
  try {
    await writeWorkspaceNetworkBootstrap(directory, { mode: "lan", ...config, denied: [] });
    const path = join(directory, "kintsugi", "network-resolv.conf");
    expect(await readFile(path, "utf8")).toBe("search home.arpa\nnameserver 192.168.20.53\n");
    expect(await readFile(join(directory, "systemd", "system", "kintsugi-init.service.d", "network.conf"), "utf8")).toContain("Requires=kintsugi-network-dns.service");
    expect(await readFile(join(directory, "systemd", "system", "kintsugi-network-dns.service"), "utf8")).toContain("Before=kintsugi-init.service");
    await writeWorkspaceNetworkBootstrap(directory, { mode: "off", cidrs: [], dns: [], search: [], denied: [] });
    expect(await readFile(path, "utf8")).toBe("");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("LAN access without configured resolvers preserves Docker DNS and activates no bootstrap", async () => {
  await setNetworkConfiguration({ ...config, dns: [] });
  await setWorkspaceNetworkMode("network-default-dns", "lan");
  expect(getWorkspaceNetworkMode("network-default-dns")).toBe("lan");
  const directory = await mkdtemp(join(tmpdir(), "network-default-dns-"));
  try {
    await writeWorkspaceNetworkBootstrap(directory, { mode: "lan", ...config, dns: [], resolver: undefined, denied: [] });
    expect(await readFile(join(directory, "kintsugi", "network-resolv.conf"), "utf8")).toBe("");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
