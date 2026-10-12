import { expect, test } from "bun:test";
import { resolverAddresses, workspaceFirewallRules } from "./firewall.ts";

test("all bridge kinds share the input and forwarding boundary, independent of names", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53"]);
  expect(rules).not.toContain("iifname");
  expect(rules).not.toContain("oifname");
  expect(rules).toContain('meta iifkind "bridge" counter drop');
  expect(rules).toContain('meta iifkind "bridge" meta oifkind "bridge" counter drop');
  expect(rules).toContain('meta iifkind "bridge" jump public_destinations');
  expect(rules).toContain('ip daddr @non_public_v4 counter drop');
  expect(rules).toContain('ip6 daddr != 2000::/3 counter drop');
  expect(rules).toContain('ip6 daddr 2001:db8::/32 counter drop');
});

test("preserves host-initiated replies and IPv6 neighbor discovery before the input deny", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53"]);
  const deny = rules.indexOf('meta iifkind "bridge" counter drop');
  for (const exception of [
    'meta iifkind "bridge" ct state established,related counter accept',
    'meta iifkind "bridge" ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } counter accept',
  ]) {
    expect(rules).toContain(exception);
    expect(rules.indexOf(exception)).toBeLessThan(deny);
  }
  // Only our table is replaced: Docker's NAT/filtering and ingress stay intact.
  expect(rules).toStartWith("add table inet kintsugi_workspaces\nflush table inet kintsugi_workspaces\n");
  expect(rules).not.toContain("flush ruleset");
});

test("build-client sockets are confined without affecting management sockets", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53"]);
  expect(rules).toContain('socket cgroupv2 level 3 "system/workloads/build-clients" jump public_egress');
  expect(rules).toContain("fib daddr type local counter drop");
  expect(rules).toContain("ip daddr @non_public_v4 counter drop");
  expect(rules).toContain("ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 counter accept");
  const output = rules.slice(rules.indexOf("  chain public_egress"), rules.indexOf("  chain input"));
  expect(output).not.toContain("ct state");
  expect(output).toContain("jump public_destinations");
  for (const path of ["", "/", "relative", "/system/../management", '/system/"injection'])
    expect(() => workspaceFirewallRules(path, [])).toThrow("Invalid build client cgroup");
  expect(() => workspaceFirewallRules("/system/build-clients", ["invalid"])).toThrow("Invalid DNS");
});

test("DNS exceptions are limited to build clients, not forwarded workloads", () => {
  const nameservers = resolverAddresses("# resolver config\nnameserver 127.0.0.53\n nameserver fd00::53 # IPv6\nsearch example.com\n");
  expect(nameservers).toEqual(["127.0.0.53", "fd00::53"]);
  const rules = workspaceFirewallRules("/system/workloads/build-clients", nameservers);
  expect(rules).toContain("ip6 daddr fd00::53 meta l4proto { tcp, udp } th dport 53 counter accept");
  const forward = rules.slice(rules.indexOf("  chain forward"));
  expect(forward).toContain('meta iifkind "bridge" jump public_destinations');
  expect(forward).not.toContain("jump public_egress");
});

test("family-specific FIB rules avoid the optional inet FIB implementation", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53", "fd00::53"]);
  const inet = rules.slice(0, rules.indexOf("add table ip "));
  expect(inet).not.toContain("fib daddr");
  for (const family of ["ip", "ip6"]) {
    expect(rules).toContain(`add table ${family} kintsugi_workspaces`);
    expect(rules).toContain(`flush table ${family} kintsugi_workspaces`);
  }
  expect(rules.match(/fib daddr type local counter drop/g)).toHaveLength(4);
  // An accept in the inet table doesn't bypass a later family table. Each
  // family's output chain must independently exempt configured DNS before FIB.
  for (const [family, resolver] of [["ip", "127.0.0.53"], ["ip6", "fd00::53"]]) {
    const table = rules.slice(rules.indexOf(`table ${family} kintsugi_workspaces {`));
    const local = table.slice(table.indexOf("chain local_destinations"));
    expect(local.indexOf(`${family} daddr ${resolver}`)).toBeLessThan(local.indexOf("fib daddr"));
  }
});

test("without NFT_SOCKET only host-side client filtering is omitted", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53"], false);
  expect(rules).not.toContain("socket cgroupv2");
  expect(rules).not.toContain("chain local_destinations");
  expect(rules.match(/meta iifkind "bridge" fib daddr type local counter drop/g)).toHaveLength(2);
  expect(rules).toContain('meta iifkind "bridge" counter drop');
  expect(rules).toContain('meta iifkind "bridge" meta oifkind "bridge" counter drop');
  expect(rules).toContain('meta iifkind "bridge" jump public_destinations');
  expect(rules).toContain("ip daddr @non_public_v4 counter drop");
});

test("workspace LAN exceptions are source-specific and cannot override bridge or control isolation", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", [], true, [{ bridge: "atw-123456789ab", policy: {
    mode: "lan", cidrs: ["192.168.10.0/24", "fd12:3456::/64"], dns: ["192.168.20.53"], search: [], denied: ["172.18.0.0/16", "93.184.215.10/32"],
  } }]);
  const lan = rules.indexOf('iifname "atw-123456789ab" ip daddr 192.168.10.0/24 counter accept');
  expect(lan).toBeGreaterThan(rules.indexOf('meta iifkind "bridge" meta oifkind "bridge" counter drop'));
  expect(lan).toBeGreaterThan(rules.indexOf('iifname "atw-123456789ab" ip daddr 172.18.0.0/16 counter drop'));
  expect(lan).toBeLessThan(rules.indexOf('meta iifkind "bridge" jump public_destinations'));
  expect(rules).toContain('iifname "atw-123456789ab" ip6 daddr fd12:3456::/64 counter accept');
  expect(rules).toContain('iifname "atw-123456789ab" ip daddr 192.168.20.53 meta l4proto { tcp, udp } th dport 53 counter accept');
  // Separate family FIB guards always run, even after an inet accept verdict.
  expect(rules.match(/meta iifkind "bridge" fib daddr type local counter drop/g)).toHaveLength(2);
  expect(rules).not.toContain('oifname "tailscale0"');
});

test("off mode cannot accidentally install a saved LAN exception", () => {
  const policy = { mode: "off", cidrs: ["192.168.10.0/24"], dns: ["192.168.10.53"], search: [], denied: [] } as const;
  expect(workspaceFirewallRules("/system/build", [], false, [{ bridge: "atw-123456789ab", policy: { ...policy, cidrs: [...policy.cidrs], dns: [...policy.dns], search: [], denied: [] } }])).not.toContain('iifname "atw-');
});

test("System resolver input grants only the owning enabled bridge's TCP/UDP port 53", () => {
  const policy = { mode: "lan", cidrs: ["192.168.10.0/24"], dns: ["192.168.10.53"], search: [], denied: [], resolver: "198.18.0.1" } as const;
  const rules = workspaceFirewallRules("/system/build", [], false, [{ bridge: "atw-123456789ab", policy: { ...policy, cidrs: [...policy.cidrs], dns: [...policy.dns], search: [], denied: [] } }]);
  const input = rules.slice(rules.indexOf("  chain input"), rules.indexOf("  chain forward"));
  expect(input).toContain('iifname "atw-123456789ab" ip daddr 198.18.0.1 meta l4proto { tcp, udp } th dport 53 counter accept');
  expect(input.indexOf("th dport 53")).toBeLessThan(input.indexOf('iifname != "lo" ip daddr 198.18.0.0/15 counter drop'));
  expect(input.indexOf("198.18.0.0/15 counter drop")).toBeLessThan(input.indexOf("ct state established,related"));
  expect(input).not.toContain("th dport 8080");
});
