import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";
import type { WorkspaceNetworkPolicy } from "@kintsugi/shared/network-policy";

/** Recompute control addresses and bridge subnets: another workspace may have
 * been created, or System readdressed, since this workspace's snapshot. */
export function withHostNetworkBoundary(policy: WorkspaceNetworkPolicy): WorkspaceNetworkPolicy {
  const local = Object.entries(networkInterfaces()).flatMap(([name, addresses]) => (addresses ?? []).map(address => {
    const bridge = name.startsWith("atw-") || existsSync(`/sys/class/net/${name}/bridge`);
    return bridge && address.cidr ? address.cidr : `${address.address}/${address.family === "IPv6" ? 128 : 32}`;
  }));
  return { ...policy, denied: [...policy.denied, ...local] };
}
