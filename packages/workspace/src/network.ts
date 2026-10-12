import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getKintsugiRuntimeContext, readTextIfExists, writeJsonAtomic, requireDocker } from "@kintsugi/core";
import { hostRequest, hostAvailable } from "@kintsugi/host/control";
import { NetworkConfigurationError, networkModeSchema, networkPolicySchema, parseNetworkConfiguration, parseNetworkPolicy, emptyNetworkConfiguration, offNetworkPolicy, privateNetworkCidrs, networkResolvConf, type WorkspaceNetworkMode, type WorkspaceNetworkPolicy, type NetworkConfiguration } from "@kintsugi/shared/network-policy";
import { createWorkspaceMetadataState } from "./metadata-state.ts";

const stateForRuntime = new Map<string, ReturnType<typeof createNetworkState>>();
interface WorkspaceNetworkState { mode: WorkspaceNetworkMode; applied?: WorkspaceNetworkPolicy }
const stateSchema = Type.Object({ mode: Type.Optional(networkModeSchema), applied: Type.Optional(networkPolicySchema) });
function createNetworkState(dataDir: string) {
  return createWorkspaceMetadataState<WorkspaceNetworkState>("network.json", value => {
    const record = Value.Parse(stateSchema, value);
    return { mode: Value.Parse(networkModeSchema, record.mode ?? "off"), applied: record.applied === undefined ? undefined : parseNetworkPolicy(record.applied) };
  }, () => ({ mode: "off" }), { dataDir });
}
function state(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new NetworkConfigurationError("Invalid workspace ID");
  const dataDir = getKintsugiRuntimeContext().kintsugiDataDir;
  let store = stateForRuntime.get(dataDir);
  if (!store) { store = createNetworkState(dataDir); stateForRuntime.set(dataDir, store); }
  return store;
}
const configPath = () => join(getKintsugiRuntimeContext().kintsugiDataDir, "network.json");
export async function getNetworkConfiguration(): Promise<NetworkConfiguration> {
  const text = await readTextIfExists(configPath());
  return text === undefined ? emptyNetworkConfiguration() : parseNetworkConfiguration(JSON.parse(text));
}
export async function setNetworkConfiguration(value: NetworkConfiguration): Promise<void> {
  await writeJsonAtomic(configPath(), parseNetworkConfiguration(value));
}
export function getWorkspaceNetworkMode(id: string): WorkspaceNetworkMode { return state(id).read(id).mode; }
export function getAppliedWorkspaceNetwork(id: string): WorkspaceNetworkPolicy { return state(id).read(id).applied ?? offNetworkPolicy(); }
export async function setWorkspaceNetworkMode(id: string, mode: WorkspaceNetworkMode): Promise<void> {
  const parsed = Value.Parse(networkModeSchema, mode);
  const config = await getNetworkConfiguration();
  if (parsed === "lan" && !config.cidrs.length) throw new NetworkConfigurationError("Configure local LAN CIDRs in Network settings first");
  state(id).write(id, { ...state(id).read(id), mode: parsed });
}
export async function workspaceNetworkRestartRequired(id: string): Promise<boolean> {
  const mode = getWorkspaceNetworkMode(id);
  const applied = getAppliedWorkspaceNetwork(id);
  if (mode !== applied.mode) return true;
  if (mode === "off") return false;
  if (applied.dns.length && !applied.resolver) return true; // Older snapshots need the System DNS bootstrap.
  const config = await getNetworkConfiguration();
  return JSON.stringify([mode === "private" ? privateNetworkCidrs : config.cidrs, config.dns, config.search]) !== JSON.stringify([applied.cidrs, applied.dns, applied.search]);
}

/** Called only while stopped, before Docker starts the container. */
export async function prepareWorkspaceNetwork(id: string): Promise<WorkspaceNetworkPolicy> {
  const mode = getWorkspaceNetworkMode(id);
  const configuration = await getNetworkConfiguration();
  if (!hostAvailable()) {
    if (mode !== "off") throw new Error("LAN permissions require a Kintsugi System deployment");
    const applied = offNetworkPolicy();
    state(id).write(id, { ...state(id).read(id), applied });
    return applied;
  }
  const applied = await hostRequest({ operation: "network", workspaceId: id, mode, configuration });
  // A settings edit during the privileged RPC remains pending, not overwritten.
  state(id).write(id, { ...state(id).read(id), applied });
  return applied;
}

export async function revokeWorkspaceNetwork(id: string): Promise<void> {
  state(id);
  if (hostAvailable()) await hostRequest({ operation: "network", workspaceId: id, mode: "off", configuration: emptyNetworkConfiguration() });
}

/** Install before start so DNS is ready before repository hooks. The unit
 * reapplies the active snapshot after Docker-owned automatic restarts too. */
export async function configureWorkspaceDns(id: string, policy: WorkspaceNetworkPolicy): Promise<void> {
  state(id); // Validate the workspace identity before constructing paths.
  const directory = join(getKintsugiRuntimeContext().kintsugiDataDir, "workspaces", id, "network-bootstrap");
  if (policy.mode === "off" && !existsSync(directory)) return;
  await writeWorkspaceNetworkBootstrap(directory, policy);
  await requireDocker(["cp", directory + "/.", `kintsugi-${id}:/etc`]);
}
export async function writeWorkspaceNetworkBootstrap(directory: string, policy: WorkspaceNetworkPolicy): Promise<void> {
  const units = join(directory, "systemd", "system");
  await mkdir(join(units, "kintsugi-init.service.d"), { recursive: true });
  await mkdir(join(directory, "kintsugi"), { recursive: true });
  await writeFile(join(directory, "kintsugi", "network-resolv.conf"), policy.mode === "off" ? "" : networkResolvConf(policy), { mode: 0o644 });
  await writeFile(join(units, "kintsugi-network-dns.service"), workspaceNetworkDnsUnit);
  await writeFile(join(units, "kintsugi-init.service.d", "network.conf"), "[Unit]\nRequires=kintsugi-network-dns.service\nAfter=kintsugi-network-dns.service\n");
}
export const workspaceNetworkDnsUnit = `[Unit]
Description=Workspace DNS forwarder configuration
DefaultDependencies=no
Before=kintsugi-init.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'if test -s /etc/kintsugi/network-resolv.conf; then cat /etc/kintsugi/network-resolv.conf > /etc/resolv.conf; fi'
`;
