import { BlockList, isIP } from "node:net";

/**
 * The workspace egress invariant: over IP, a workspace may reach global
 * unicast destinations (the public internet) and nothing else.
 *
 * Kintsugi's own services are never valid destinations. The app, the
 * supervisor and every other control channel are reached through per-workspace
 * Unix sockets with fixed route lists, not through the network. Private
 * networks (LAN, VPN, tailnet, Docker bridges) are not reachable either; when
 * a workspace legitimately needs one, allow an exact host through the proxy's
 * hook layer instead of reopening a whole range here.
 *
 * This module is the one policy definition for both enforcement layers: the
 * System nftables firewall (images/system/src/firewall.ts) and the egress
 * proxy's destination check (packages/proxy-egress), so they cannot drift.
 */

/** Special-purpose IPv4 ranges that are never workspace egress destinations. */
export const blockedEgressIpv4Ranges: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["0.0.0.0", 8], // "this network", broadcast abuse
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // CGNAT / Tailscale tailnet
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC1918 private, Docker bridges
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918 private, most LANs
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
];

/** The only globally routed IPv6 block; it excludes loopback, ULA and everything non-global. */
export const allowedEgressIpv6Range = { address: "2000::", prefix: 3 } as const;

/** Global-range exceptions that are never workspace egress destinations. */
export const blockedEgressIpv6Ranges: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["2001:db8::", 32], // documentation
];

const blockedIpv4 = new BlockList();
for (const [address, prefix] of blockedEgressIpv4Ranges) blockedIpv4.addSubnet(address, prefix, "ipv4");

const allowedIpv6 = new BlockList();
allowedIpv6.addSubnet(allowedEgressIpv6Range.address, allowedEgressIpv6Range.prefix, "ipv6");

const blockedIpv6 = new BlockList();
for (const [address, prefix] of blockedEgressIpv6Ranges) blockedIpv6.addSubnet(address, prefix, "ipv6");

/** True when `ip` may be a workspace egress destination; literal addresses only. */
export function isWorkspaceEgressAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blockedIpv4.check(ip, "ipv4");
  if (family === 6) return allowedIpv6.check(ip, "ipv6") && !blockedIpv6.check(ip, "ipv6");
  return false;
}

/** nftables set elements for the System firewall, generated from the same list the proxy enforces. */
export function workspaceEgressNftIpv4Elements(): string {
  return blockedEgressIpv4Ranges.map(([address, prefix]) => `${address}/${prefix}`).join(",\n      ");
}
