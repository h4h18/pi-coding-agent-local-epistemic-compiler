#!/usr/bin/env bash
set -euo pipefail

# llama.cpp 0.4.0 (b10809) Vulkan on loopback for FA-EX1 gfx1151 / Qwen3.8-27B.
# HIP remains a non-selected fallback that still builds from a source tree.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_linux
require_loopback_host

BACKEND="${1:-}"
GGUF="${2:-}"
EXPECTED_SHA="${3:-}"
PORT="${LLAMA_PORT:-8000}"
PARALLEL="${LLAMA_PARALLEL:-4}"
SLOT_CTX="${LLAMA_SLOT_CTX:-262144}"
UBATCH="${LLAMA_UBATCH:-1024}"
BATCH="${LLAMA_BATCH:-2048}"

if [[ "${BACKEND}" != "hip" && "${BACKEND}" != "vulkan" ]]; then
  die_json "usage: run-llamacpp.sh <hip|vulkan> <model.gguf> <sha256>"
fi
if [[ -z "${GGUF}" || -z "${EXPECTED_SHA}" ]]; then
  die_json "usage: run-llamacpp.sh <hip|vulkan> <model.gguf> <sha256>"
fi
if [[ ! -f "${GGUF}" ]]; then
  die_json "gguf missing: ${GGUF}"
fi
verify_sha256 "${GGUF}" "${EXPECTED_SHA}"

if [[ "${BACKEND}" == "hip" ]]; then
  LLAMA_CPP_ROOT="${LLAMA_CPP_ROOT:-}"
  if [[ -z "${LLAMA_CPP_ROOT}" ]]; then
    die_json "LLAMA_CPP_ROOT must point at a llama.cpp 0.4.0 source tree for HIP"
  fi
  if [[ ! -f "${LLAMA_CPP_ROOT}/CMakeLists.txt" ]]; then
    die_json "LLAMA_CPP_ROOT is not a llama.cpp tree"
  fi
  if ! grep -E '0\.4\.0|10809' "${LLAMA_CPP_ROOT}/CMakeLists.txt" >/dev/null 2>&1 \
    && ! grep -E '0\.4\.0|10809' "${LLAMA_CPP_ROOT}/version.h" >/dev/null 2>&1 \
    && { [[ ! -f "${LLAMA_CPP_ROOT}/version.txt" ]] || ! grep -E '0\.4\.0|10809' "${LLAMA_CPP_ROOT}/version.txt" >/dev/null 2>&1; }; then
    die_json "llama.cpp tree is not pinned to 0.4.0 / b10809"
  fi
  BUILD_DIR="${LLAMA_CPP_ROOT}/build-${BACKEND}"
  cmake -S "${LLAMA_CPP_ROOT}" -B "${BUILD_DIR}" -DGGML_HIP=ON -DAMDGPU_TARGETS="gfx1150;gfx1151"
  cmake --build "${BUILD_DIR}" --config Release -j"$(nproc)"
  SERVER="${BUILD_DIR}/bin/llama-server"
  if [[ ! -x "${SERVER}" ]]; then
    SERVER="${BUILD_DIR}/llama-server"
  fi
else
  SERVER="${LLAMA_CPP_BIN:-/opt/llama.cpp/bin/llama-server}"
  if [[ ! -x "${SERVER}" ]]; then
    die_json "llama-server missing; run install-llamacpp.sh"
  fi
  if [[ -f /opt/llama.cpp/version.txt ]] && ! grep -q '0.4.0' /opt/llama.cpp/version.txt; then
    die_json "installed llama.cpp is not 0.4.0"
  fi
  export LD_LIBRARY_PATH="/opt/llama.cpp/bin:/opt/llama.cpp/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

if [[ ! -x "${SERVER}" ]]; then
  die_json "llama-server is not executable"
fi

ARGS=(
  -m "${GGUF}"
  --host 127.0.0.1
  --port "${PORT}"
  --alias "Qwen/Qwen3.8-27B"
  -ngl 99
  -np "${PARALLEL}"
  --kv-unified
  --kv-unified-per-slot "${SLOT_CTX}"
  --ubatch-size "${UBATCH}"
  --batch-size "${BATCH}"
  --flash-attn on
  --cache-type-k q8_0
  --cache-type-v q8_0
  --jinja
  --metrics
)

if [[ "${LLAMA_MTP:-1}" == "1" ]]; then
  ARGS+=(--spec-type draft-mtp)
fi

exec "${SERVER}" "${ARGS[@]}"
