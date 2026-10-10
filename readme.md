# Kintsugi

[![Kintsugi](docs/icon-256.png)](docs/icon.png)

Kintsugi is an opinionated fork of [AgentsInTheCloud](https://github.com/lucasmeijer/AgentsInTheCloud), originally created by Lucas Meijer. It runs coding agents on your own infrastructure, with your choice of model providers and tools for evaluating their work.

This fork adds:

- An embedded Draw.io editor and diagram previews.
- A scoped, token-authenticated management API.
- Configurable Docker release sources, private GHCR authentication, pinned updates and installer rollback.
- Word wrapping in the file viewer, including Markdown source mode.
- GitHub Copilot subscription usage, quota information and calendar-month pacing.
- Unattended installation and transactional admin bootstrap with private token delivery.
- Trusted LAN proxy access with configurable preview origins, Caddy TLS termination and persistent publications.
- Tag-only releases with native AMD64/ARM64 builds, staged checks, shared caches and selective CI.

The name comes from **金継ぎ**, the Japanese art of repairing pottery with gold, because the original project was a brilliant way to glue together several components and I wanted to honor that approach.

> You can read [this blog post](https://taoofmac.com/space/blog/2026/10/10/1200#a-coding-environment) for the motivation behind this fork.

## Installation

Use a dedicated Linux server with Docker. The installer defaults to `ghcr.io/rcarmo/kintsugi` and `ghcr.io/rcarmo/kintsugi-system`; matching images must be available before installation.

```sh
curl -fsSL https://raw.githubusercontent.com/rcarmo/kintsugi/main/scripts/install.sh -o /tmp/install-kintsugi.sh
bash /tmp/install-kintsugi.sh --action install
```

EROFS is the default. For a fresh installation on a host without EROFS support, use OverlayFS:

```sh
bash /tmp/install-kintsugi.sh --action install --storage-driver overlayfs
```

OverlayFS uses more disk space and initial provisioning I/O. Updates retain the selected driver; in-place switching is unsupported. See [storage requirements](docs/automation.md#installer-setup-update-and-rollback) for kernel and image compatibility.

Setup asks for the app image repository and Tailscale machine name. System defaults to the app repository with `-system` appended. For locally built or separately named images, use `--app-image` and `--system-image`. Private GHCR sources accept `--registry-config FILE`. See [automation](docs/automation.md) for source selection, updates and rollback.

For unattended setup and LAN access, follow the [deployment instructions](docs/automation.md#trusted-lan-proxy-deployment-v002). Use the installer from the selected release tag, with matching app and System version tags. Cloning the repository does not install a running service.

## Management API

Kintsugi provides an optional token-authenticated JSON management API for host-local or LAN automation without Tailscale. It is **disabled by default**. Configure listeners and issue scoped tokens with `apps/web/scripts/admin-bindings.ts`.

Scopes cover workspace lifecycle, templates and shared configuration, secrets, SSH configuration, host diagnostics, and release/update management. Every request, including `GET /openapi.json`, requires `Authorization: Bearer <token>`. The `security` scope grants administrative power, including issuing tokens; grant it sparingly.

Non-loopback listeners require TLS, including listeners published through Docker. The installer publishes no admin ports unless explicitly requested with `--admin-publish IP:HOST_PORT:ADMIN_PORT`. Docker publications can bypass host firewall rules: bind to a trusted interface and enforce network filtering. See [admin setup and permissions](docs/automation.md#optional-authenticated-admin-bindings) for configuration, certificates, token storage and revocation.

The normal app also supports JSON representations of UI operations for agents and Work views. Those use the app's existing access boundary and require a matching `Origin` on mutations; this CSRF check is not authentication. Agent prompting, arbitrary commands and terminal access are not exposed through admin listeners.

## Development

```sh
bun install
bun run check
bun run web
```

Internal packages use `@kintsugi/*`. Container accounts are `agent:agent`, with `/home/agent` as their home. The app uses UID/GID 1000; workspace startup aligns the numeric IDs with the host process to preserve shared-volume ownership. Existing `ATELIER_*` environment variables keep their names for compatibility.

## Attribution and licence

Kintsugi derives from [AgentsInTheCloud](https://github.com/lucasmeijer/AgentsInTheCloud), originally created by Lucas Meijer. The original copyright and [MIT licence](LICENSE) are retained. Third-party attributions are in [NOTICE](NOTICE).
