#!/usr/bin/env bash
set -euo pipefail

# Official ROCm 7.2.1 for gfx1150/gfx1151 on Ubuntu 24.04 (noble).
# Sources (resolved 2026-08-28T08:45:00.000Z):
# https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-7.2.1/docs/compatibility/compatibilityryz/native_linux/native_linux_compatibility.html
# https://rocm.docs.amd.com/projects/install-on-linux/en/docs-7.2.1/install/install-methods/package-manager/package-manager-ubuntu.html
# PyTorch 2.9.1 + Python 3.12 production matrix for this ROCm release.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_linux

if [[ ! -f /etc/os-release ]]; then
  die_json "/etc/os-release missing"
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${VERSION_CODENAME:-}" != "noble" ]]; then
  die_json "ROCm 7.2.1 native-linux matrix for gfx1150/gfx1151 is Ubuntu 24.04 noble"
fi

install -d -m 0755 /etc/apt/keyrings
wget -q -O - https://repo.radeon.com/rocm/rocm.gpg.key | gpg --dearmor | tee /etc/apt/keyrings/rocm.gpg >/dev/null
tee /etc/apt/sources.list.d/rocm.list >/dev/null <<'EOF'
deb [arch=amd64 signed-by=/etc/apt/keyrings/rocm.gpg] https://repo.radeon.com/rocm/apt/7.2.1 noble main
deb [arch=amd64 signed-by=/etc/apt/keyrings/rocm.gpg] https://repo.radeon.com/graphics/7.2.1/ubuntu noble main
EOF
tee /etc/apt/preferences.d/rocm-pin-600 >/dev/null <<'EOF'
Package: *
Pin: release o=repo.radeon.com
Pin-Priority: 600
EOF

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y rocm

if ! command -v rocminfo >/dev/null 2>&1; then
  die_json "rocminfo missing after ROCm 7.2.1 install"
fi

if ! rocminfo | grep -E 'gfx1150|gfx1151' >/dev/null 2>&1; then
  die_json "rocminfo did not report gfx1150 or gfx1151"
fi

printf '{"ok":true,"rocm":"7.2.1","architectures":["gfx1150","gfx1151"]}\n'
