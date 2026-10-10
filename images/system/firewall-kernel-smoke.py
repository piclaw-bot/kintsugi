#!/usr/bin/env python3
"""Real nft kernel/atomicity regression; runs on Linux or Docker Desktop/macOS.
Run from the repository root: python3 images/system/firewall-kernel-smoke.py
Uses a disposable privileged container, never the host network namespace.
"""
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="aitc-firewall-kernel-") as directory:
    path = pathlib.Path(directory)
    for enabled in (True, False):
        source = 'import {workspaceFirewallRules} from "./images/system/src/firewall.ts"; process.stdout.write(workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53", "::1"], ' + str(enabled).lower() + '));'
        rules = subprocess.check_output(["bun", "-e", source], cwd=root)
        (path / ("protected.nft" if enabled else "bridge-only.nft")).write_bytes(rules)
    script = r'''
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nftables iproute2 python3 >/tmp/install.log
cgroup=$(sed -n 's/^0:://p' /proc/self/cgroup)
relative=${cgroup#/}
level=$(printf '%s' "$relative" | awk -F/ '{print NF}')
sed -e "s|system/workloads/build-clients|$relative|g" -e "s|cgroupv2 level 3 |cgroupv2 level $level |g" /rules/protected.nft >/tmp/protected.nft
cat >/tmp/probe.nft <<EOF
add table inet aitc_socket_preflight
add chain inet aitc_socket_preflight output { type filter hook output priority -10; policy accept; }
add rule inet aitc_socket_preflight output socket cgroupv2 level $level "$relative" counter
EOF
if nft -c -f /tmp/probe.nft 2>/tmp/probe.err; then
  protected=true
else
  cat /tmp/probe.err
  grep -q 'Could not process rule: No such file or directory' /tmp/probe.err
  protected=false
fi
# A check must not have committed its probe table.
if nft list table inet aitc_socket_preflight >/dev/null 2>&1; then exit 1; fi
# Always exercise the exact rule set used on kernels without NFT_SOCKET.
nft -f /rules/bridge-only.nft
nft -f /rules/bridge-only.nft
for family in inet ip ip6; do nft list table "$family" kintsugi_workspaces; done
# Atomic failure: an unresolved set reference is accepted by the parser but
# rejected by the kernel. None of the preceding flushes may have committed.
nft add table inet unrelated_docker_fixture
nft -s list ruleset >/tmp/before.nft
cp /rules/bridge-only.nft /tmp/broken.nft
printf '\nadd rule ip kintsugi_workspaces forward ip daddr @missing_set drop\n' >>/tmp/broken.nft
if nft -f /tmp/broken.nft 2>/tmp/broken.err; then exit 1; fi
nft -s list ruleset >/tmp/after.nft
cmp /tmp/before.nft /tmp/after.nft
# Exercise actual packet lookup in both family FIB implementations. A synthetic
# output hook selects this fixture, not management traffic in production.
for family in ip ip6; do
  nft "add chain $family kintsugi_workspaces fib_fixture { type filter hook output priority -12; policy accept; }"
  nft "add rule $family kintsugi_workspaces fib_fixture fib daddr type local counter drop"
done
python3 - <<'PY'
import errno, socket
for family, destination in [(socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')]:
    with socket.socket(family, socket.SOCK_DGRAM) as probe:
        try:
            probe.sendto(b'FIB regression probe', (destination, 54321))
        except OSError as error:
            assert error.errno == errno.EPERM, error
PY
for family in ip ip6; do
  nft list chain "$family" kintsugi_workspaces fib_fixture | grep -E 'counter packets [1-9][0-9]*'
  nft flush chain "$family" kintsugi_workspaces fib_fixture
  nft delete chain "$family" kintsugi_workspaces fib_fixture
done
if [ "$protected" = true ]; then
  nft -f /tmp/protected.nft
  nft -f /tmp/protected.nft
  python3 - <<'PYTEST'
import errno, socket
for family, destination in [(socket.AF_INET, '127.0.0.53'), (socket.AF_INET6, '::1')]:
    for port in (53, 54):
        with socket.socket(family, socket.SOCK_DGRAM) as probe:
            try:
                probe.sendto(b'DNS exception probe', (destination, port))
            except OSError as error:
                assert port == 54 and error.errno == errno.EPERM, error
            else:
                assert port == 53, 'local non-DNS traffic must be dropped'
PYTEST
  for family in ip ip6; do
    nft list chain "$family" kintsugi_workspaces local_destinations | grep -E 'counter packets [1-9][0-9]*.*accept'
    nft list chain "$family" kintsugi_workspaces local_destinations | grep -E 'counter packets [1-9][0-9]*.*drop'
  done
fi
printf 'PASS: bridge-only rules, IPv4/IPv6 kernel FIB packet lookup, atomic replacement/rollback; NFT_SOCKET=%s\n' "$protected"
'''
    subprocess.run([
        "docker", "run", "--rm", "--privileged", "--cgroupns=host",
        "--mount", f"type=bind,src={path},dst=/rules,readonly",
        "--entrypoint", "sh", "ubuntu:26.04", "-ec", script,
    ], check=True)
