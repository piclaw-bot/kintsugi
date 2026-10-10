import dns from "node:dns/promises";
import { isIP } from "node:net";
import { getAppliedWorkspaceNetwork } from "@kintsugi/workspace";
import { addressInCidrs, type WorkspaceNetworkPolicy } from "@kintsugi/shared/network-policy";
import { withHostNetworkBoundary } from "./network-boundary.ts";

export async function lookupNetworkHost(hostname: string, policy: WorkspaceNetworkPolicy): Promise<Array<{ address: string; family: number }>> {
  const family = isIP(hostname);
  if (family) return [{ address: hostname, family }];
  if (policy.mode === "off") return dns.lookup(hostname, { all: true, verbatim: false });
  if (policy.dns.some(address => addressInCidrs(address, policy.denied))) throw new Error("DNS forwarder cannot be a Kintsugi control or workspace address");
  const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(policy.dns);
  const candidates = hostname.includes(".") ? [hostname] : [...policy.search.map(suffix => `${hostname}.${suffix}`), hostname];
  let failure: unknown;
  for (const candidate of candidates) {
    const results = await Promise.allSettled([resolver.resolve4(candidate), resolver.resolve6(candidate)]);
    const addresses = results.flatMap((result, index) => result.status === "fulfilled" ? result.value.map(address => ({ address, family: index ? 6 : 4 })) : []);
    // A family with no records is normal; timeouts and server errors must not be
    // hidden by a successful answer from the other family.
    for (const result of results) if (result.status === "rejected") {
      const code = result.reason?.code;
      if (code !== "ENODATA" && code !== "ENOTFOUND") throw result.reason;
      failure = result.reason;
    }
    if (addresses.length) return addresses;
  }
  throw failure ?? new Error(`Could not resolve ${hostname}`);
}
export function lookupWorkspaceHost(workspaceId: string, hostname: string) {
  return lookupNetworkHost(hostname, withHostNetworkBoundary(getAppliedWorkspaceNetwork(workspaceId)));
}
