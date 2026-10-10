import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isNotFoundError, writeJsonAtomic, createKeyedOperationQueue } from "../../../packages/core/src/index.ts";
import { command } from "./process.ts";
import { installWorkspaceFirewall, resolverAddresses } from "./firewall.ts";
import { addressInCidrs, canonicalNetworkCidr, parseNetworkConfiguration, parseNetworkPolicy, privateNetworkCidrs, offNetworkPolicy, type WorkspaceNetworkPolicy, type WorkspaceNetworkMode, type NetworkConfiguration } from "../../../packages/shared/src/network-policy.ts";

export function workspaceNetworkBridge(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new Error("Invalid workspace ID");
  return `atw-${createHash("sha256").update(id).digest("hex").slice(0, 11)}`;
}

export async function systemNetworkDestinations(): Promise<string[]> {
  const links = JSON.parse(await command(["ip", "-j", "-d", "address", "show"]));
  return links.flatMap((link: { linkinfo?: { info_kind?: string }; addr_info: Array<{ family: string; local: string; prefixlen: number }> }) => link.addr_info
    .filter(address => address.family === "inet" || address.family === "inet6")
    .map(address => canonicalNetworkCidr(`${address.local}/${link.linkinfo?.info_kind === "bridge" ? address.prefixlen : address.family === "inet" ? 32 : 128}`)));
}

/** Privileged control is only on the app-owned Unix socket. Settings never
 * arrive from workspace traffic or a public supervisor endpoint. */
export async function createWorkspaceNetworkControl(buildClientsCgroup: string, path = "/data/supervisor/workspace-networks.json") {
  const serialize = createKeyedOperationQueue();
  type WorkspacePolicies = Record<string, WorkspaceNetworkPolicy>;
  let policies: WorkspacePolicies = {};
  try {
    const saved = JSON.parse(await readFile(path, "utf8"));
    for (const [id, policy] of Object.entries(saved)) { workspaceNetworkBridge(id); policies[id] = parseNetworkPolicy(policy); }
  } catch (error) { if (!isNotFoundError(error)) throw error; }
  const install = async (next: WorkspacePolicies) => {
    const denied = await systemNetworkDestinations();
    const networks = Object.entries(next).map(([id, policy]) => ({ bridge: workspaceNetworkBridge(id), policy: { ...policy, denied } }));
    await installWorkspaceFirewall(buildClientsCgroup, resolverAddresses(await readFile("/etc/resolv.conf", "utf8")), networks);
  };
  // Restore permissions before dockerd can auto-start existing containers.
  await install(policies);
  return (request: { workspaceId: string; mode: WorkspaceNetworkMode; configuration: NetworkConfiguration }): Promise<WorkspaceNetworkPolicy> => serialize("network", async () => {
    workspaceNetworkBridge(request.workspaceId);
    const config = parseNetworkConfiguration(request.configuration);
    if (request.mode !== "off" && !config.dns.length) throw new Error("Configure a LAN DNS forwarder before enabling LAN access");
    if (request.mode === "lan" && !config.cidrs.length) throw new Error("Configure local LAN CIDRs before enabling Local LAN access");
    const policy: WorkspaceNetworkPolicy = request.mode === "off" ? { ...offNetworkPolicy(), denied: await systemNetworkDestinations() } : {
      mode: request.mode, cidrs: request.mode === "private" ? [...privateNetworkCidrs] : config.cidrs,
      dns: config.dns, search: config.search, denied: await systemNetworkDestinations(),
    };
    if (policy.dns.some(address => addressInCidrs(address, policy.denied))) throw new Error("DNS forwarder cannot be a Kintsugi control or workspace address");
    const next = { ...policies, [request.workspaceId]: policy };
    await install(next);
    try { await writeJsonAtomic(path, next, { mode: 0o600 }); }
    catch (error) { await install(policies); throw error; }
    policies = next;
    return policy;
  });
}
