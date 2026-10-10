#!/usr/bin/env bash
set -euo pipefail
image=${1:?Image reference required}
machine=${2:?Native machine required}
case "$machine" in x86_64|aarch64) ;; *) exit 1 ;; esac

# Startup itself needs System and the real workspace image. Check the native
# binaries, module layout and regenerated client assets without rebuilding that
# dependency or pretending a stand-in workspace is a release acceptance test.
command=$(cat <<'SMOKE'
test "$(uname -m)" = "$1"
bun --version
kintsugi-dockerd /usr/local/bin/dockerd --version
bun -e '
  import { existsSync } from "node:fs";
  import { parseAssetManifest } from "./apps/web/src/server/asset-manifest.ts";
  await import("@kintsugi/core");
  const manifest = parseAssetManifest(await Bun.file("apps/web/public/assets-manifest.json").text());
  for (const path of Object.values(manifest)) {
    if (!existsSync(`apps/web/public${path}`)) throw new Error(`Missing client asset: ${path}`);
  }
  console.log("Native core modules and compiled client assets verified");
'
SMOKE
)
docker run --rm --entrypoint /bin/sh "$image" -ec "$command" sh "$machine"
