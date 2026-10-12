import dns from "node:dns/promises";
import { isIP } from "node:net";
import { getAppliedWorkspaceNetwork } from "@kintsugi/workspace";
import { addressInCidrs, type WorkspaceNetworkPolicy } from "@kintsugi/shared/network-policy";
import { withHostNetworkBoundary } from "./network-boundary.ts";

export async function lookupNetworkHost(hostname: string, policy: WorkspaceNetworkPolicy): Promise<Array<{ address: string; family: number }>> {
  const family = isIP(hostname);
  if (family) return [{ address: hostname, family }];
  if (policy.mode === "off" || !policy.dns.length) return dns.lookup(hostname, { all: true, verbatim: false });
  if (policy.dns.some(address => addressInCidrs(address, policy.denied))) throw new Error("DNS forwarder cannot be a Kintsugi control or workspace address");
  // Query separately: Resolver.setServers stops on NXDOMAIN instead of
  // consulting the next configured forwarder.
  const resolvers = (policy.resolver ? [policy.resolver] : policy.dns).map(server => {
    // The System view can spend three seconds on each of three upstreams.
    const resolver = new dns.Resolver({ timeout: policy.resolver ? 10_000 : 3000, tries: policy.resolver ? 1 : 2 });
    resolver.setServers([server]);
    return resolver;
  });
  const candidates = hostname.includes(".") ? [hostname] : [...policy.search.map(suffix => `${hostname}.${suffix}`), hostname];
  let failure: unknown;
  for (const candidate of candidates) {
    let serverFailure: unknown;
    for (const resolver of resolvers) {
      const results = await Promise.allSettled([resolver.resolve4(candidate), resolver.resolve6(candidate)]);
      const addresses = results.flatMap((result, index) => result.status === "fulfilled" ? result.value.map(address => ({ address, family: index ? 6 : 4 })) : []);
      let retry = false;
      for (const result of results) if (result.status === "rejected") {
        const code = result.reason?.code;
        if (code === "ENODATA" || code === "ENOTFOUND") failure = result.reason;
        else if (["ETIMEOUT", "ECONNREFUSED", "ESERVFAIL", "EREFUSED"].includes(code)) {
          serverFailure = result.reason;
          retry = true;
        } else throw result.reason;
      }
      // Never mask an operational failure in one family with the other family's
      // answer. Retry the whole name with the next configured resolver instead.
      if (!retry && addresses.length) return addresses;
    }
    if (serverFailure) throw serverFailure;
  }
  throw failure ?? new Error(`Could not resolve ${hostname}`);
}
export function lookupWorkspaceHost(workspaceId: string, hostname: string) {
  return lookupNetworkHost(hostname, withHostNetworkBoundary(getAppliedWorkspaceNetwork(workspaceId)));
}
