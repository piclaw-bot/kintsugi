# Kintsugi

[![Kintsugi](docs/icon-256.png)](docs/icon.png)

Kintsugi is an opinionated fork of [AgentsInTheCloud](https://github.com/lucasmeijer/AgentsInTheCloud), originally created by Lucas Meijer. It runs coding agents on your own infrastructure, with your choice of model providers and tools for evaluating their work.

The fork adds an embedded Draw.io editor and diagram previews, configurable Docker release sources, private GHCR authentication, pinned updates and installer rollback. The name comes from **金継ぎ**, the Japanese art of repairing pottery with gold.

## Installation

Use a dedicated Linux server with Docker. This branch selects `ghcr.io/rcarmo/kintsugi` and `ghcr.io/rcarmo/kintsugi-system`; matching images must be available before installation.

```sh
curl -fsSL https://raw.githubusercontent.com/rcarmo/kintsugi/feature/rebranding-kintsugi/scripts/install.sh -o /tmp/install-kintsugi.sh
bash /tmp/install-kintsugi.sh --action install
```

Setup asks for the app image repository and Tailscale machine name. System defaults to the app repository with `-system` appended. For locally built or separately named images, use `--app-image` and `--system-image`. Private GHCR sources accept `--registry-config FILE`. See [automation](docs/automation.md) for source selection, updates and rollback.

## Management API

The app exposes an HTTP management interface for workspaces, agents, Work views and configuration. Discover its endpoints and request schemas at `GET /openapi.json`. Send `Accept: application/json` to request JSON representations of supported UI operations.

```sh
curl -fsS http://localhost:3000/workspaces \
  -H 'Accept: application/json'
```

Mutations also require `Content-Type: application/json` and an `Origin` header matching the app URL. The interface uses the app's existing access boundary; the `Origin` check prevents CSRF, not unauthorised access. Do not expose it to untrusted networks. See [automation](docs/automation.md) for commands, configuration and access requirements.

## Development

```sh
bun install
bun run check
bun run web
```

Internal packages use `@kintsugi/*`. Container accounts are `agent:agent`, with `/home/agent` as their home. The app uses UID/GID 1000; workspace startup aligns the numeric IDs with the host process to preserve shared-volume ownership. Existing `ATELIER_*` environment variables keep their names for compatibility.

## Attribution and licence

Kintsugi derives from [AgentsInTheCloud](https://github.com/lucasmeijer/AgentsInTheCloud), originally created by Lucas Meijer. The original copyright and [MIT licence](LICENSE) are retained. Third-party attributions are in [NOTICE](NOTICE).
