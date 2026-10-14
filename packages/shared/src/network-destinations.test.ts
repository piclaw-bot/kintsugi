import { expect, test } from "bun:test";
import { formatPrivateNetworkDestination, parsePrivateNetworkDestination, parsePrivateNetworkDestinations, privateNetworkDestinationAddressAllowed, privateNetworkDestinationAllowed } from "./network-destinations.ts";

for (const [input, expected] of [
  [" DB.Internal.:05432 ", "db.internal:5432"],
  ["192.168.1.20:22", "192.168.1.20:22"],
  ["172.20.8.1:443", "172.20.8.1:443"],
  ["[fd12:0000::1]:443", "[fd12::1]:443"],
] as const) {
  test(`canonical exact destination ${input}`, () => {
    expect(formatPrivateNetworkDestination(parsePrivateNetworkDestination(input))).toBe(expected);
  });
}

for (const input of ["https://db.internal:443", "db.internal:0", "db.internal:65536", "db.internal:1.5", "db.internal:*", "db.internal\n:22", "db.internal\r:22", "*.internal:443", "db.internal:443/path", "user:secret@db.internal:443", "192.168.1.0/24:22", "[db.internal]:22", "[fe80::1%eth0]:22", "127.0.0.1:22", "169.254.169.254:80", "100.64.0.1:22", "[fd7a:115c:a1e0::1]:22", "8.8.8.8:53", "localhost:22", "foo.localhost:22", "256.0.0.1:22", "010.0.0.1:22"]) {
  test(`unsupported or protected destination ${input}`, () => {
    expect(() => parsePrivateNetworkDestination(input)).toThrow();
  });
}

test("lists are bounded, support comments and deduplicate canonical spellings", () => {
  expect(parsePrivateNetworkDestinations("# No permissions are enabled by parsing\nDB.INTERNAL:22\ndb.internal.:0022\n\n")).toEqual([{ host: "db.internal", port: 22 }]);
  expect(() => parsePrivateNetworkDestinations(Array.from({ length: 129 }, (_, n) => `host${n}.internal:22`).join("\n"))).toThrow("At most 128");
  expect(() => parsePrivateNetworkDestinations(" ".repeat(65537))).toThrow("too long");
});

test("exact matching cannot open ports, new DNS answers, other names or disabled access", () => {
  const destinations = [{ host: "db.internal", port: 5432, addresses: ["192.168.1.20"] }];
  const request = { hostname: "DB.INTERNAL.", ip: "192.168.1.20", port: 5432 };
  expect(privateNetworkDestinationAllowed(destinations, request, { enabled: true, denied: [] })).toBe(true);
  expect(privateNetworkDestinationAllowed(destinations, request, { enabled: false, denied: [] })).toBe(false);
  expect(privateNetworkDestinationAllowed(destinations, { ...request, port: 443 }, { enabled: true, denied: [] })).toBe(false);
  expect(privateNetworkDestinationAllowed(destinations, { ...request, hostname: "other.internal" }, { enabled: true, denied: [] })).toBe(false);
  expect(privateNetworkDestinationAllowed(destinations, { ...request, ip: "192.168.1.21" }, { enabled: true, denied: [] })).toBe(false);
  expect(privateNetworkDestinationAllowed(destinations, request, { enabled: true, denied: ["192.168.1.0/24"] })).toBe(false);
});

test("System/control and peer exclusions always override explicitly listed private addresses", () => {
  for (const ip of ["10.0.0.1", "172.20.0.10", "192.168.1.20", "fd12::1"]) {
    const cidr = `${ip}/${ip.includes(":") ? 128 : 32}`;
    expect(privateNetworkDestinationAddressAllowed(ip, [])).toBe(true);
    expect(privateNetworkDestinationAddressAllowed(ip, [cidr])).toBe(false);
    expect(privateNetworkDestinationAllowed([{ host: "db.internal", port: 22, addresses: [ip] }], { hostname: "db.internal", ip, port: 22 }, { enabled: true, denied: [cidr] })).toBe(false);
  }
  for (const ip of ["127.0.0.1", "169.254.169.254", "100.64.0.1", "fd7a:115c:a1e0::1", "fe80::1", "fd12::1%eth0", "8.8.8.8", "::ffff:192.168.1.20"]) expect(privateNetworkDestinationAddressAllowed(ip, [])).toBe(false);
});

test("IPv6 spelling and URL brackets do not change the exact destination", () => {
  const destination = parsePrivateNetworkDestination("[fd12::1]:443");
  expect(privateNetworkDestinationAllowed([{ ...destination, addresses: ["fd12::1"] }], { hostname: "[fd12:0000::1]", ip: "fd12:0:0:0:0:0:0:1", port: 443 }, { enabled: true, denied: [] })).toBe(true);
});
