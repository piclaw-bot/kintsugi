# Workspace network policy

Workspace LAN access is a persistent, opt-in egress permission. It defaults to `off`, requires System for runtime enforcement, and applies to every process and agent in the workspace. It is independent of UI/admin listener exposure and Tailscale subnet-route acceptance. This implementation does not install routes or run a DNS/mDNS helper.

## Modes and configuration

| Mode | Additional destinations |
| --- | --- |
| `off` | None; retain public-internet egress and default Docker DNS |
| `lan` | Installation-configured LAN CIDRs |
| `private` | RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and IPv6 ULA (`fc00::/7`) |

Existing host routes must reach the selected destinations. Both enabled modes require at least one configured DNS forwarder; `lan` also requires at least one CIDR. The installation configuration has three required arrays:

```json
{"cidrs":["192.168.10.0/24","fd12:3456::/64"],"dns":["192.168.10.53"],"search":["home.arpa"]}
```

Limits are 64 CIDRs, three DNS forwarder IP addresses and six search domains. Forwarders use TCP/UDP port 53; hostnames, scoped IPv6 addresses and custom ports are unsupported. CIDRs are canonicalised and deduplicated. Groups overlapping protected ranges are rejected.

The operator supplies a reachable DNS forwarder that resolves LAN names, forwards public queries and handles `.local` names through mDNS, for example `rcarmo/mdnsbridge`. Kintsugi provides hostname resolution through ordinary DNS; it does not relay multicast or provide Bonjour service browsing.

## Desired and applied state

Saving a workspace mode or installation configuration does not change running workspace permissions. A workspace stores its desired mode separately from its applied policy snapshot. `restartRequired` compares the desired mode and current installation configuration against that snapshot; Off ignores installation DNS/CIDR edits.

Apply changes by parking and unparking the workspace through Kintsugi. Parking closes terminal and VS Code views. An automatic Docker restart retains the applied snapshot; restarting System restores the saved firewall policies before dockerd starts. Neither operation substitutes for applying desired changes through Kintsugi's workspace lifecycle.

The lifecycle `beforeStart` hook prepares the policy through private host control, records the applied snapshot and copies the DNS bootstrap into the stopped container before Docker starts it. Settings edits made while the host request is in flight remain pending. Enabled modes fail startup without System; Off retains direct-development support.

The bootstrap adds `kintsugi-network-dns.service` before `kintsugi-init.service`, making DNS available to repository hooks. Docker regenerates `/etc/resolv.conf` on restart, so the unit reapplies the snapshot at each boot. Applying Off restores Docker's resolver configuration.

## Enforcement and isolation

- Shared validation and address rules live in `packages/shared/src/network-policy.ts`; the existing public-unicast policy remains the default.
- `images/system/src/workspace-network.ts` validates workspace/container/bridge identity through the private host-control `network` operation, discovers current System addresses and bridge subnets with `ip -j -d address show`, and installs persistent policies.
- `images/system/src/firewall.ts` adds source-bridge-specific exceptions. DNS forwarders outside the selected CIDRs receive only port-53 access. Input filtering, kernel FIB-local checks and bridge-to-bridge denial retain management and peer isolation.
- `packages/proxy-egress/src/secrets/workspace-secrets.ts` checks destinations against the applied snapshot. `egress/network-boundary.ts` recomputes local addresses and bridge subnets so later workspace creation or System readdressing cannot make an old snapshot authorise control destinations.
- `egress/workspace-dns.ts` uses the configured forwarders for LAN search names and `.local`; literal IPs bypass DNS. Forwarders cannot use denied control or workspace addresses. Proxy destination checks and address pinning still apply after resolution.

Tailnet, link-local, multicast, metadata and reserved destinations remain protected even in Private mode. IPv4/IPv6 CIDR support does not create missing IPv6 connectivity. Privileged containers retain their existing separate security implications.

## Persistence and control

Paths below are relative to the app's configured data directory unless absolute:

| State | Location |
| --- | --- |
| Installation CIDRs/DNS/search | `network.json` |
| Workspace desired/applied policy | Workspace metadata `network.json`, managed by `createWorkspaceMetadataState` |
| Generated DNS bootstrap | `workspaces/<id>/network-bootstrap/` |
| System saved policies | `/data/supervisor/workspace-networks.json` |
| Private host-control socket | `/run/kintsugi-host/control.sock` |

Workspace bridge names are `atw-` plus the first 11 SHA256 hexadecimal characters of the workspace ID. Host control is private infrastructure, not an admin HTTP endpoint. Unexpected I/O or privileged-operation failures propagate; only configuration errors receive user-facing validation handling.

## UI and admin API

`apps/web/src/server/settings/network.ts` renders installation settings under **Settings → Network** and per-workspace Network dialogs. These use server-rendered forms and Turbo responses. Both surfaces report pending restart status.

Admin reads and mutations require the **`security` scope**, bearer authentication and the usual admin JSON contract. Other scopes alone cannot read network configuration. See [admin bindings](automation.md#optional-authenticated-admin-bindings) for listener setup and TLS requirements.

| Method | Path | Body |
| --- | --- | --- |
| GET | `/settings/network` | None |
| POST | `/settings/network` | Installation configuration above; replaces all three arrays |
| GET | `/workspaces/{id}/network` | None |
| POST | `/workspaces/{id}/network` | `{"mode":"off"}`, `{"mode":"lan"}` or `{"mode":"private"}` |

Installation responses contain `network.cidrs`, `network.dns` and `network.search`. Workspace responses contain `network.mode` (desired), `network.applied` (mode, CIDRs, DNS, search and denied ranges) and `network.restartRequired`. Installation writes do not restart workspaces. Park/unpark endpoints separately require `workspaces`; avoid forced parking without reviewing open views. Schemas and scope requirements are included in `/openapi.json`.

## Verification

From the repository root:

```sh
bun run check
bun test packages/shared/src/network-policy.test.ts packages/workspace/test/network.test.ts packages/proxy-egress/test/workspace-dns.test.ts apps/web/test/admin-network.test.ts images/system/src/firewall.test.ts
python3 images/system/firewall-kernel-smoke.py
bun run packages/workspace/scripts/test-network-dns.ts <local-workspace-image>
```

The kernel test uses disposable privileged containers and isolated namespaces to exercise IPv4/IPv6 Off/LAN/Private access, DNS-only exceptions, management/peer isolation, revocation and restoration. The DNS test requires a local systemd workspace image and checks DNS before init, reapplication after Docker restart and restoration when disabled. Neither test changes host DNS or a live installation. Proxy and shared-policy tests cover forwarder boundaries and protected ranges; admin tests cover persistence, defaults, validation, scope enforcement and OpenAPI schemas. No UI tests are added.
