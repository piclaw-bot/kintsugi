#!/usr/bin/env bash
set -euo pipefail
image="$1"; directory="$2"
name="kintsugi-resource-probe-$$-$(date +%s)"
stress_image="kintsugi-resource-stress:$name"
tmp="$(mktemp -d)"
cleanup() { docker rm -fv "$name" >"$tmp/cleanup.log" 2>&1 || true; docker image rm "$stress_image" >>"$tmp/cleanup.log" 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
cp "$directory/stress.c" "$tmp/"
cc -O2 -Wno-unused-result -static -o "$tmp/stress" "$tmp/stress.c"
printf 'FROM scratch\nCOPY stress /stress\nENTRYPOINT ["/stress"]\n' > "$tmp/Dockerfile"
docker build --quiet -t "$stress_image" "$tmp"
docker save "$stress_image" -o "$tmp/stress.tar"
docker create --name "$name" --user 0:0 --privileged --cgroupns=host --network none --memory 4g --memory-swap 4608m --pids-limit 8192 --cpus 2 --entrypoint bun "$image" /tmp/resource-control-probe.js "$stress_image"
docker cp "$directory/resource-control-probe.js" "$name:/tmp/resource-control-probe.js"
docker cp "$directory/resource-budget-probe.js" "$name:/tmp/resource-budget-probe.js"
docker cp "$tmp/stress.tar" "$name:/tmp/stress.tar"
docker start -a "$name"
exit "$(docker inspect --format '{{.State.ExitCode}}' "$name")"
