#!/usr/bin/env bash
set -euo pipefail

# PyTorch 2.9.1 + Python 3.12 wheels from AMD Ryzen native-linux docs (ROCm 7.2.1).
# Re-qualified 2026-08-28 from:
# https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-7.2.1/docs/install/installrad/native_linux/install-pytorch.html
# Ubuntu 24.04 cp312 wheels at repo.radeon.com/rocm/manylinux/rocm-rel-7.2.1 (not PyTorch.org nightlies).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_linux

PY_MAJOR_MINOR="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "${PY_MAJOR_MINOR}" != "3.12" ]]; then
  die_json "PyTorch 2.9.1 ROCm 7.2.1 Ubuntu 24.04 wheels require Python 3.12"
fi

WORKDIR="${PYTORCH_WHEEL_DIR:-/tmp/pi-hec-pytorch-2.9.1}"
install -d -m 0755 "${WORKDIR}"
cd "${WORKDIR}"

wget -q -O "torch-2.9.1+rocm7.2.1.lw.gitff65f5bc-cp312-cp312-linux_x86_64.whl" \
  "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1.lw.gitff65f5bc-cp312-cp312-linux_x86_64.whl"
wget -q -O "torchvision-0.24.0+rocm7.2.1.gitb919bd0c-cp312-cp312-linux_x86_64.whl" \
  "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2.1/torchvision-0.24.0%2Brocm7.2.1.gitb919bd0c-cp312-cp312-linux_x86_64.whl"
wget -q -O "triton-3.5.1+rocm7.2.1.gita272dfa8-cp312-cp312-linux_x86_64.whl" \
  "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2.1/triton-3.5.1%2Brocm7.2.1.gita272dfa8-cp312-cp312-linux_x86_64.whl"
wget -q -O "torchaudio-2.9.0+rocm7.2.1.gite3c6ee2b-cp312-cp312-linux_x86_64.whl" \
  "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2.1/torchaudio-2.9.0%2Brocm7.2.1.gite3c6ee2b-cp312-cp312-linux_x86_64.whl"

pip3 uninstall -y torch torchvision triton torchaudio
pip3 install --break-system-packages \
  "torch-2.9.1+rocm7.2.1.lw.gitff65f5bc-cp312-cp312-linux_x86_64.whl" \
  "torchvision-0.24.0+rocm7.2.1.gitb919bd0c-cp312-cp312-linux_x86_64.whl" \
  "torchaudio-2.9.0+rocm7.2.1.gite3c6ee2b-cp312-cp312-linux_x86_64.whl" \
  "triton-3.5.1+rocm7.2.1.gita272dfa8-cp312-cp312-linux_x86_64.whl"

python3 -c "import torch; assert torch.__version__.startswith('2.9.1')"
printf '{"ok":true,"torch":"2.9.1","python":"3.12","rocm":"7.2.1"}\n'
