import { expect, test } from "bun:test";
import { createWorkspaceMetadataState } from "@kintsugi/workspace";
import type { WorkspaceNetworkPolicy } from "@kintsugi/shared/network-policy";
import { createWorkspaceSecretContext, forgetWorkspaceSecretContext } from "../src/secrets/workspace-secrets.ts";
import { lookupWorkspaceHost } from "../src/egress/workspace-dns.ts";

const id = "proxy-listed-hosts";
const applied: WorkspaceNetworkPolicy = { mode: "hosts", cidrs: [], dns: [], search: [], denied: ["10.199.254.249/32"], destinations: [{ host: "db.internal", port: 5432, addresses: ["10.199.254.250"] }] };

test("the actual secret context and proxy resolver share pinned host/port permissions", async () => {
  const store = createWorkspaceMetadataState<{ mode: "hosts"; applied: WorkspaceNetworkPolicy }>("network.json", () => ({ mode: "hosts", applied }), () => ({ mode: "hosts", applied }));
  store.write(id, { mode: "hosts", applied });
  const context = await createWorkspaceSecretContext(id, undefined);
  try {
    const request = { hostname: "db.internal", ip: "10.199.254.250", port: 5432, family: 4 as const, protocol: "https" as const };
    expect(await context.hooks.isIpAllowed!(request)).toBe(true);
    expect(await context.hooks.isIpAllowed!({ ...request, port: 22 })).toBe(false);
    expect(await context.hooks.isIpAllowed!({ ...request, hostname: "other.internal" })).toBe(false);
    expect(await context.hooks.isIpAllowed!({ ...request, ip: "10.199.254.249" })).toBe(false);
    expect(await context.hooks.isIpAllowed!({ ...request, ip: "10.199.254.251" })).toBe(false);
    expect(await lookupWorkspaceHost(id, "DB.INTERNAL.")).toEqual([{ address: "10.199.254.250", family: 4 }]);
  } finally { forgetWorkspaceSecretContext(id); store.delete(id); }
});
