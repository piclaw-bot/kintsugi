import { expect, test } from "bun:test";
import { addressInCidrs, emptyNetworkConfiguration, networkResolvConf, offNetworkPolicy, parseNetworkConfiguration, parseNetworkCidr, privateNetworkCidrs, workspaceNetworkAddressAllowed, type WorkspaceNetworkPolicy } from "./network-policy.ts";

const lan: WorkspaceNetworkPolicy = { mode: "lan", cidrs: ["192.168.10.0/24", "fd12:3456::/64"], dns: ["192.168.20.53"], search: ["home.arpa"], denied: ["192.168.10.1/32", "172.18.0.0/16"] };
test("LAN permissions are opt-in and CIDR scoped for both address families", () => {
  for (const address of ["192.168.10.20", "fd12:3456::20"]) {
    expect(workspaceNetworkAddressAllowed(address, offNetworkPolicy())).toBe(false);
    expect(workspaceNetworkAddressAllowed(address, lan)).toBe(true);
  }
  for (const address of ["192.168.11.20", "10.1.2.3", "fd12:3457::20"]) expect(workspaceNetworkAddressAllowed(address, lan)).toBe(false);
  for (const address of ["8.8.8.8", "2606:4700::1111"]) expect(workspaceNetworkAddressAllowed(address, lan)).toBe(true);
});
test("routed private scope excludes control, tailnet, metadata and multicast", () => {
  const policy = { ...lan, mode: "private", cidrs: privateNetworkCidrs } satisfies WorkspaceNetworkPolicy;
  for (const address of ["192.168.11.20", "10.1.2.3", "fd12:3457::20"]) expect(workspaceNetworkAddressAllowed(address, policy)).toBe(true);
  for (const address of ["192.168.10.1", "172.18.0.40", "100.64.0.1", "fd7a:115c:a1e0::20", "169.254.169.254", "127.0.0.1", "fe80::1", "ff02::fb", "224.0.0.251", "::ffff:192.168.10.20", "not-an-ip"]) expect(workspaceNetworkAddressAllowed(address, policy)).toBe(false);
});
test("configuration validates lists without permitting firewall or resolv.conf injection", () => {
  expect(parseNetworkConfiguration(emptyNetworkConfiguration())).toEqual(emptyNetworkConfiguration());
  expect(parseNetworkConfiguration({ cidrs: ["192.168.10.0/24", "192.168.10.0/24"], dns: ["192.168.1.53"], search: ["home.arpa"] }).cidrs).toEqual(["192.168.10.0/24"]);
  for (const cidr of ["0.0.0.0/0", "::/0", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "ff00::/8", "fc00::/7", "192.168.1.0/33", '192.168.1.0/24; accept', "192.168.1.0/-1"]) expect(() => parseNetworkConfiguration({ cidrs: [cidr], dns: [], search: [] })).toThrow();
  for (const dns of ["dns.home", "192.168.1.1:53", "1.1.1.1\nnameserver 2.2.2.2"]) expect(() => parseNetworkConfiguration({ cidrs: [], dns: [dns], search: [] })).toThrow();
  expect(() => parseNetworkConfiguration({ cidrs: [], dns: [], search: ["home\nnameserver 1.1.1.1"] })).toThrow();
});
test("DNS uses exactly the configured forwarders and search list", () => {
  expect(networkResolvConf(lan)).toBe("search home.arpa\nnameserver 192.168.20.53\n");
  expect(addressInCidrs("192.168.10.255", lan.cidrs)).toBe(true);
  expect(parseNetworkCidr("fd12:3456::/64").family).toBe(6);
});
