import { command } from "./process.ts";
import { startDnsForwarder, type DnsForwarder } from "./dns-forwarder.ts";
import { addressInCidrs, parseNetworkPolicy, withHostNetworkBoundary, type WorkspaceNetworkPolicy } from "../../../packages/shared/src/network-policy.ts";

export type WorkspacePolicies = Record<string, WorkspaceNetworkPolicy>;
const device = "kintsugi-dns";

/** Reserved benchmark space is denied by normal egress. Only the owning bridge
 * gets port-53 access to its view; no physical interface or management address. */
export function assignWorkspaceResolvers(policies: WorkspacePolicies) {
  const next: WorkspacePolicies = {};
  const used = new Set<string>();
  for (const [id, policy] of Object.entries(policies)) {
    parseNetworkPolicy(policy);
    if (policy.mode === "off" || !policy.dns.length) next[id] = { ...policy, resolver: undefined };
    else {
      if (policy.resolver && used.has(policy.resolver)) throw new Error("Duplicate workspace resolver address");
      if (policy.resolver) used.add(policy.resolver);
      next[id] = { ...policy };
    }
  }
  let index = 1;
  for (const policy of Object.values(next)) if (policy.mode !== "off" && policy.dns.length && !policy.resolver) {
    let address: string;
    do {
      if (index >= 131071) throw new Error("Workspace resolver address pool exhausted");
      address = `198.${18 + (index >> 16)}.${(index >> 8) & 255}.${index & 255}`;
      index++;
    } while (used.has(address));
    policy.resolver = address;
    used.add(address);
  }
  return next;
}

export function createWorkspaceResolverControl() {
  const running = new Map<string, { server: DnsForwarder; view: { policy: WorkspaceNetworkPolicy } }>();
  let ready = false;
  return async (policies: WorkspacePolicies): Promise<void> => {
    const enabled = Object.values(policies).filter(policy => policy.mode !== "off" && policy.dns.length && policy.resolver);
    if (enabled.length && !ready) {
      const links: Array<{ ifname: string }> = JSON.parse(await command(["ip", "-j", "link", "show"]));
      if (!links.some(link => link.ifname === device)) await command(["ip", "link", "add", device, "type", "dummy"]);
      await command(["ip", "link", "set", device, "up"]);
      ready = true;
    }
    const staged: string[] = [];
    try {
      for (const policy of enabled) {
        const address = policy.resolver!;
        if (running.has(address)) continue;
        await command(["ip", "address", "replace", `${address}/32`, "dev", device]);
        let server: DnsForwarder;
        const view = { policy };
        try {
          server = await startDnsForwarder(address, () => {
            const current = withHostNetworkBoundary(view.policy);
            // A new bridge may now own an address previously used by a forwarder.
            if (current.dns.some(ip => addressInCidrs(ip, current.denied))) return [];
            return current.dns.map(ip => ({ address: ip }));
          });
        } catch (error) { await command(["ip", "address", "del", `${address}/32`, "dev", device]); throw error; }
        running.set(address, { server, view });
        staged.push(address);
      }
    } catch (error) {
      for (const address of staged) {
        await running.get(address)!.server.close();
        running.delete(address);
        await command(["ip", "address", "del", `${address}/32`, "dev", device]);
      }
      throw error;
    }
    const wanted = new Map(enabled.map(policy => [policy.resolver!, policy]));
    for (const [address, view] of running) {
      const policy = wanted.get(address);
      if (policy) view.view.policy = policy;
      else {
        await view.server.close();
        running.delete(address);
        await command(["ip", "address", "del", `${address}/32`, "dev", device]);
      }
    }
    if (!enabled.length && ready) {
      await command(["ip", "link", "del", device]);
      ready = false;
    }
  };
}
