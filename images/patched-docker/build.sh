#!/bin/bash
set -euo pipefail
# Local multi-platform image: images/patched-docker/build.sh --load
# Explicit image name: images/patched-docker/build.sh REGISTRY/IMAGE:TAG --push
# Native-only development: append --platform linux/arm64 (or linux/amd64).
# Derived images: FROM REGISTRY/IMAGE@sha256:... . Use the default docker Buildx
# driver inside them; docker-container builders have an independent BuildKit.
build_image=kintsugi-patched-docker:dev
if [[ $# -gt 0 && "$1" != -* ]]; then
    build_image=$1
    shift
fi
# Buildx accumulates repeated --platform flags; omit our default when the caller
# chooses one explicitly.
default_platforms=true
for argument in "$@"; do
    case "$argument" in --platform|--platform=*) default_platforms=false ;; esac
done
if "$default_platforms"; then
    set -- --platform linux/arm64,linux/amd64 "$@"
fi
source_label=$(cd "$(dirname "$0")/../.." && bun -e 'import {imageSource} from "./packages/shared/src/publishing.ts"; process.stdout.write(imageSource)')
exec docker buildx build \
    --tag "$build_image" \
    --label "org.opencontainers.image.source=$source_label" \
    "$@" "$(cd "$(dirname "$0")" && pwd)"
