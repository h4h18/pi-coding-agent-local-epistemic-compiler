#!/usr/bin/env bash
set -euo pipefail

# llama.cpp 0.3.0 HIP or Vulkan on loopback.
# Stable pin: https://github.com/ggml-org/llama.cpp/releases/tag/v0.3.0 (2026-08-25)
# Nightly b10xxx is refused as the production pin.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_linux
require_loopback_host

BACKEND="${1:-}"
GGUF="${2:-}"
EXPECTED_SHA="${3:-}"
PORT="${LLAMA_PORT:-8080}"

if [[ "${BACKEND}" != "hip" && "${BACKEND}" != "vulkan" ]]; then
  die_json "usage: run-llamacpp.sh <hip|vulkan> <model.gguf> <sha256>"
fi
if [[ -z "${GGUF}" || -z "${EXPECTED_SHA}" ]]; then
  die_json "usage: run-llamacpp.sh <hip|vulkan> <model.gguf> <sha256>"
fi
verify_sha256 "${GGUF}" "${EXPECTED_SHA}"

LLAMA_CPP_ROOT="${LLAMA_CPP_ROOT:-}"
if [[ -z "${LLAMA_CPP_ROOT}" ]]; then
  die_json "LLAMA_CPP_ROOT must point at a llama.cpp 0.3.0 tree"
fi

if [[ ! -f "${LLAMA_CPP_ROOT}/CMakeLists.txt" ]]; then
  die_json "LLAMA_CPP_ROOT is not a llama.cpp tree"
fi
if ! grep -q '0.3.0' "${LLAMA_CPP_ROOT}/CMakeLists.txt" && ! grep -q '0.3.0' "${LLAMA_CPP_ROOT}/version.h" 2>/dev/null; then
  if [[ ! -f "${LLAMA_CPP_ROOT}/version.txt" ]] || ! grep -q '0.3.0' "${LLAMA_CPP_ROOT}/version.txt"; then
    die_json "llama.cpp tree is not pinned to 0.3.0"
  fi
fi

BUILD_DIR="${LLAMA_CPP_ROOT}/build-${BACKEND}"
if [[ "${BACKEND}" == "hip" ]]; then
  cmake -S "${LLAMA_CPP_ROOT}" -B "${BUILD_DIR}" -DGGML_HIP=ON -DAMDGPU_TARGETS="gfx1150;gfx1151"
else
  cmake -S "${LLAMA_CPP_ROOT}" -B "${BUILD_DIR}" -DGGML_VULKAN=ON
fi
cmake --build "${BUILD_DIR}" --config Release -j"$(nproc)"

SERVER="${BUILD_DIR}/bin/llama-server"
if [[ ! -x "${SERVER}" ]]; then
  SERVER="${BUILD_DIR}/llama-server"
fi

exec "${SERVER}" -m "${GGUF}" --host 127.0.0.1 --port "${PORT}"
