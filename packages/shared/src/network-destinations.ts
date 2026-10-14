import { isIP } from "node:net";
import { NetworkConfigurationError, addressInCidrs, privateNetworkCidrs, protectedNetworkCidrs } from "./network-policy.ts";

/** An exact TCP destination. Parsing or saving it does not enable private access. */
export interface PrivateNetworkDestination { host: string; port: number }
/** Addresses pinned when a permission snapshot is applied; later DNS answers do not widen it. */
export interface AppliedPrivateNetworkDestination extends PrivateNetworkDestination { addresses: readonly string[] }

const hostnamePattern = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
const invalidDestination = () => new NetworkConfigurationError("Use an exact host:port, IPv4:port or [IPv6]:port. URLs, wildcards, paths and CIDRs are not supported.");
function requestedHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  return !host.includes("%") && isIP(host) === 6 ? new URL(`https://[${host}]`).hostname.slice(1, -1) : host;
}

/** Same private ranges and protected boundaries as the existing CIDR modes. */
export function privateNetworkDestinationAddressAllowed(address: string, denied: readonly string[]): boolean {
  if (!isIP(address) || address.includes("%")) return false;
  return addressInCidrs(address, privateNetworkCidrs) && !addressInCidrs(address, protectedNetworkCidrs) && !addressInCidrs(address, denied);
}

export function parsePrivateNetworkDestination(entry: string): PrivateNetworkDestination {
  if (entry.length > 300) throw invalidDestination();
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(entry.trim().toLowerCase());
  const port = Number(match?.[3]);
  if (!match || port < 1 || port > 65535) throw invalidDestination();
  let host = requestedHost(match[1] ?? match[2]!);
  const family = isIP(host);
  if (/\s/.test(host) || host.includes("%") || match[1] !== undefined && family !== 6) throw invalidDestination();
  if (family) {
    if (!privateNetworkDestinationAddressAllowed(host, [])) throw new NetworkConfigurationError("Only private addresses outside protected ranges can be listed.");
    if (family === 6) host = new URL(`https://[${host}]`).hostname.slice(1, -1);
  } else if (!hostnamePattern.test(host) || /^[0-9.]+$/.test(host) || host === "localhost" || host.endsWith(".localhost")) throw invalidDestination();
  return { host, port };
}

export function formatPrivateNetworkDestination(destination: PrivateNetworkDestination): string {
  return `${isIP(destination.host) === 6 ? `[${destination.host}]` : destination.host}:${destination.port}`;
}

/** One entry per line; canonicalisation makes duplicate spellings one permission. */
export function parsePrivateNetworkDestinations(input: string): PrivateNetworkDestination[] {
  if (input.length > 65536) throw new NetworkConfigurationError("Private destination list is too long.");
  const entries = new Map<string, PrivateNetworkDestination>();
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const destination = parsePrivateNetworkDestination(line);
    entries.set(formatPrivateNetworkDestination(destination), destination);
    if (entries.size > 128) throw new NetworkConfigurationError("At most 128 private destinations can be listed per scope.");
  }
  return [...entries.values()];
}

/** Permission exception only: Off stays closed, ports and pinned addresses must match, and denials always win. */
export function privateNetworkDestinationAllowed(destinations: readonly AppliedPrivateNetworkDestination[], request: { hostname: string; ip: string; port: number }, policy: { enabled: boolean; denied: readonly string[] }): boolean {
  if (!policy.enabled || !Number.isInteger(request.port) || request.port < 1 || request.port > 65535 || !privateNetworkDestinationAddressAllowed(request.ip, policy.denied)) return false;
  const host = requestedHost(request.hostname);
  return destinations.some(destination => destination.host === host && destination.port === request.port && destination.addresses.some(address => requestedHost(address) === requestedHost(request.ip)));
}
