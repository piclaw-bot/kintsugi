import { isIP } from "node:net";
import { lookupNetworkHost } from "../../../packages/shared/src/network-lookup.ts";
import { formatPrivateNetworkDestination, parsePrivateNetworkDestination, privateNetworkDestinationAddressAllowed, type AppliedPrivateNetworkDestination, type PrivateNetworkDestination } from "../../../packages/shared/src/network-destinations.ts";
import type { WorkspaceNetworkPolicy } from "../../../packages/shared/src/network-policy.ts";

type Lookup = typeof lookupNetworkHost;

/** Resolve an authorised list through the workspace's DNS view, once per applied snapshot. */
export async function resolvePrivateNetworkDestinations(entries: readonly PrivateNetworkDestination[], policy: WorkspaceNetworkPolicy, lookup: Lookup = lookupNetworkHost): Promise<AppliedPrivateNetworkDestination[]> {
  if (policy.mode !== "hosts") throw new Error("Exact destinations require listed-host mode");
  if (entries.length > 256) throw new Error("Too many effective private destinations");
  const canonical = new Map(entries.map(entry => {
    const parsed = parsePrivateNetworkDestination(formatPrivateNetworkDestination(entry));
    return [formatPrivateNetworkDestination(parsed), parsed];
  }));
  const destinations = [...canonical.values()];
  const result: AppliedPrivateNetworkDestination[] = [];
  const hosts = new Map<string, ReturnType<Lookup>>();
  // Bound concurrent DNS work. Any failed batch aborts the apply, leaving the previous policy authoritative.
  for (let offset = 0; offset < destinations.length; offset += 8) {
    const resolved = await Promise.all(destinations.slice(offset, offset + 8).map(async destination => {
      const family = isIP(destination.host);
      if (!hosts.has(destination.host)) hosts.set(destination.host, family ? Promise.resolve([{ address: destination.host, family }]) : lookup(destination.host, policy));
      const answers = await hosts.get(destination.host)!;
      const addresses = [...new Set(answers.map(answer => answer.address).filter(address => privateNetworkDestinationAddressAllowed(address, policy.denied)))];
      if (!addresses.length || addresses.length > 32) throw new Error("A listed host has no permitted private addresses or too many answers. Check the host list and DNS settings.");
      return { ...destination, addresses };
    }));
    result.push(...resolved);
  }
  return result;
}
