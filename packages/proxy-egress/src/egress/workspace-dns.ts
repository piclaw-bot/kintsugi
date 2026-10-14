import { isIP } from "node:net";
import { lookupNetworkHost } from "@kintsugi/shared/network-lookup";
export { lookupNetworkHost } from "@kintsugi/shared/network-lookup";
import { privateNetworkDestinationHost, privateNetworkDestinationAddressAllowed } from "@kintsugi/shared/network-destinations";
import { getAppliedWorkspaceNetwork } from "@kintsugi/workspace";
import { withHostNetworkBoundary } from "./network-boundary.ts";

export function lookupWorkspaceHost(workspaceId: string, hostname: string) {
  const policy = withHostNetworkBoundary(getAppliedWorkspaceNetwork(workspaceId));
  if (policy.mode === "hosts") {
    const destination = policy.destinations?.find(entry => entry.host === privateNetworkDestinationHost(hostname));
    if (destination) {
      const addresses = destination.addresses.filter(address => privateNetworkDestinationAddressAllowed(address, policy.denied));
      if (!addresses.length) throw new Error("The listed host is now protected; restart after checking network settings.");
      return Promise.resolve(addresses.map(address => ({ address, family: isIP(address) })));
    }
  }
  return lookupNetworkHost(hostname, policy);
}
