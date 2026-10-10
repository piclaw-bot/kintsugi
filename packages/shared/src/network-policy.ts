import type { JsonValue } from "@kintsugi/core";
import { BlockList, isIP } from "node:net";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isWorkspaceEgressAddress } from "./egress-policy.ts";

export class NetworkConfigurationError extends Error {}

export const networkModeSchema = Type.Union([Type.Literal("off"), Type.Literal("lan"), Type.Literal("private")]);
export type WorkspaceNetworkMode = Static<typeof networkModeSchema>;
export const networkConfigurationSchema = Type.Object({
  cidrs: Type.Array(Type.String(), { maxItems: 64 }),
  dns: Type.Array(Type.String(), { maxItems: 3 }),
  search: Type.Array(Type.String(), { maxItems: 6 }),
}, { additionalProperties: false });
export type NetworkConfiguration = Static<typeof networkConfigurationSchema>;
export const networkPolicySchema = Type.Object({
  mode: networkModeSchema,
  cidrs: Type.Array(Type.String(), { maxItems: 64 }),
  dns: Type.Array(Type.String(), { maxItems: 3 }),
  search: Type.Array(Type.String(), { maxItems: 6 }),
  denied: Type.Array(Type.String()),
}, { additionalProperties: false });
export type WorkspaceNetworkPolicy = Static<typeof networkPolicySchema>;
export const emptyNetworkConfiguration = (): NetworkConfiguration => ({ cidrs: [], dns: [], search: [] });
export const offNetworkPolicy = (): WorkspaceNetworkPolicy => ({ mode: "off", ...emptyNetworkConfiguration(), denied: [] });
export const privateNetworkCidrs = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];
// Link-local IPv6 cannot be routed from a workspace; multicast remains isolated.
export const protectedNetworkCidrs = ["0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32", "224.0.0.0/4", "240.0.0.0/4", "::/96", "::ffff:0:0/96", "fe80::/10", "ff00::/8", "fd7a:115c:a1e0::/48"];

export function parseNetworkCidr(value: string) {
  const match = /^([^/]+)\/(\d+)$/.exec(value);
  const address = match?.[1] ?? "";
  const family = isIP(address);
  const prefix = Number(match?.[2]);
  if (!match || (family !== 4 && family !== 6) || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw new NetworkConfigurationError(`Invalid network CIDR: ${value}`);
  return { address, prefix, family };
}

/** nft accepts network prefixes, not arbitrary host addresses with a mask. */
export function canonicalNetworkCidr(value: string): string {
  const { address, prefix, family } = parseNetworkCidr(value);
  if (family === 4) {
    const number = address.split(".").reduce((n, part) => (n << 8) | Number(part), 0) >>> 0;
    const network = prefix === 0 ? 0 : number & (0xffffffff << (32 - prefix));
    return `${[24, 16, 8, 0].map(shift => (network >>> shift) & 255).join(".")}/${prefix}`;
  }
  if (address.includes(".")) throw new NetworkConfigurationError("IPv4-mapped network CIDRs are not supported");
  const [left, right] = address.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const words = right === undefined ? start : [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end];
  const number = words.reduce((n, word) => (n << 16n) | BigInt(parseInt(word, 16)), 0n);
  const shift = BigInt(128 - prefix);
  const network = (number >> shift) << shift;
  const result = Array.from({ length: 8 }, (_, index) => ((network >> BigInt((7 - index) * 16)) & 65535n).toString(16)).join(":");
  return `${new URL(`http://[${result}]`).hostname.slice(1, -1)}/${prefix}`;
}

export function addressInCidrs(ip: string, cidrs: readonly string[]): boolean {
  const family = isIP(ip);
  if (family !== 4 && family !== 6) return false;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const subnet = parseNetworkCidr(cidr);
    if (subnet.family === family) list.addSubnet(subnet.address, subnet.prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return list.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export function parseNetworkConfiguration(value: JsonValue): NetworkConfiguration {
  if (!Value.Check(networkConfigurationSchema, value)) throw new NetworkConfigurationError("Expected CIDRs, DNS forwarder addresses, and search domain lists");
  const config = value;
  for (const cidr of config.cidrs) {
    const subnet = parseNetworkCidr(cidr);
    // Never permit broad groups that include protected address space.
    for (const blocked of protectedNetworkCidrs) {
      const deny = parseNetworkCidr(blocked);
      if (deny.family === subnet.family && (addressInCidrs(subnet.address, [blocked]) || addressInCidrs(deny.address, [cidr]))) throw new NetworkConfigurationError(`LAN CIDR overlaps protected address space: ${cidr}`);
    }
  }
  for (const address of config.dns) if (!isIP(address) || address.includes("%") || addressInCidrs(address, protectedNetworkCidrs)) throw new NetworkConfigurationError(`DNS forwarder must be an IP address: ${address}`);
  for (const suffix of config.search) if (suffix.length > 253 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(suffix)) throw new NetworkConfigurationError(`Invalid DNS search domain: ${suffix}`);
  return { cidrs: [...new Set(config.cidrs.map(canonicalNetworkCidr))], dns: [...new Set(config.dns)], search: [...new Set(config.search)] };
}

export function parseNetworkPolicy(value: JsonValue): WorkspaceNetworkPolicy {
  const policy = Value.Parse(networkPolicySchema, value);
  parseNetworkConfiguration({ cidrs: policy.mode === "private" ? [] : policy.cidrs, dns: policy.dns, search: policy.search });
  for (const cidr of [...policy.cidrs, ...policy.denied]) parseNetworkCidr(cidr);
  return policy;
}

export function workspaceNetworkAddressAllowed(ip: string, policy: WorkspaceNetworkPolicy): boolean {
  if (addressInCidrs(ip, policy.denied)) return false;
  if (isWorkspaceEgressAddress(ip)) return true;
  return policy.mode !== "off" && !addressInCidrs(ip, protectedNetworkCidrs) && addressInCidrs(ip, policy.cidrs);
}

export function networkResolvConf(policy: WorkspaceNetworkPolicy): string {
  return `${policy.search.length ? `search ${policy.search.join(" ")}\n` : ""}${policy.dns.map(address => `nameserver ${address}\n`).join("")}`;
}
