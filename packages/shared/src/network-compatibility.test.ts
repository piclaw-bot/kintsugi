import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertNetworkStateCompatible, requiredNetworkStateVersion } from "./network-compatibility.ts";
import { networkPolicyVersionLabel, systemVersionLabel } from "./system-version.ts";

test("network data blocks incompatible image downgrades until Off is applied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "network-data-version-"));
  try {
    expect(await requiredNetworkStateVersion(dir)).toBe(0);
    const metadata = join(dir, "app/workspaces/workspace-one/metadata"); await mkdir(metadata, { recursive: true });
    const applied = { mode: "hosts", cidrs: [], dns: [], search: [], denied: [], destinations: [{ host: "db.internal", port: 22, addresses: ["192.168.1.20"] }] };
    await writeFile(join(metadata, "network.json"), JSON.stringify({ mode: "off", applied }));
    expect(await requiredNetworkStateVersion(dir)).toBe(2);
    expect(() => assertNetworkStateCompatible(2, {}, {})).toThrow("apply Off");
    expect(() => assertNetworkStateCompatible(2, { [networkPolicyVersionLabel]: "0" }, { [systemVersionLabel]: "2" })).toThrow();
    expect(() => assertNetworkStateCompatible(2, { [networkPolicyVersionLabel]: "2" }, { [systemVersionLabel]: "2" })).not.toThrow();
    await writeFile(join(metadata, "network.json"), JSON.stringify({ mode: "off", applied: { mode: "off", cidrs: [], dns: [], search: [], denied: [] } }));
    expect(await requiredNetworkStateVersion(dir)).toBe(0);
    await mkdir(join(dir, "supervisor")); await writeFile(join(dir, "supervisor/workspace-networks.json"), JSON.stringify({ workspaceone: applied }));
    expect(await requiredNetworkStateVersion(dir)).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("non-workspace entries do not block compatibility discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "network-state-directories-"));
  try {
    await mkdir(join(dir, "app/workspaces"), { recursive: true });
    await writeFile(join(dir, "app/workspaces", "index.json"), "{}");
    expect(await requiredNetworkStateVersion(dir)).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
