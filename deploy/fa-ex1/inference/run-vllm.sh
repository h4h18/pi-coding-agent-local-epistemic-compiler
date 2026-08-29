#!/usr/bin/env bash
set -euo pipefail

# vLLM 0.27.0 on loopback. Structured outputs: extra_body structured_outputs.json
# (StructuredOutputsParams / HTTP structured_outputs). Pre-v0.12 guided fields are gone.
# Docs: https://docs.vllm.ai/en/stable/features/structured_outputs/
# PyPI pin: https://pypi.org/project/vllm/0.27.0/ (released 2026-08-10)
#
# ROCm wheels: docs.vllm.ai GPU install says the rocm721 index is nightly after
# commit 171775f306a333a9cf105bfd533bf3e113d401d9. This script does not install
# that nightly index. A verified gfx1151 wheel digest must be supplied.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_linux
require_loopback_host

MODEL="${1:-}"
WHEEL_PIN_FILE="${VLLM_ROCM_WHEEL_PIN:-}"
PORT="${VLLM_PORT:-8000}"

if [[ -z "${MODEL}" ]]; then
  die_json "usage: run-vllm.sh <huggingface-or-local-model-path>"
fi

if [[ -z "${WHEEL_PIN_FILE}" || ! -f "${WHEEL_PIN_FILE}" ]]; then
  die_json "no verified vLLM 0.27.0 gfx1151 wheel pin; rocm721 is nightly after 171775f306a333a9cf105bfd533bf3e113d401d9; refuse unverified nightly"
fi

WHEEL_PATH="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8"))["path"])' "${WHEEL_PIN_FILE}")" || die_json "wheel pin JSON must include path, sha256, and hashed requirements"
WHEEL_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8"))["sha256"])' "${WHEEL_PIN_FILE}")" || die_json "wheel pin JSON must include path, sha256, and hashed requirements"
REQUIREMENTS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8"))["requirements"])' "${WHEEL_PIN_FILE}")" || die_json "wheel pin JSON must include path, sha256, and hashed requirements"
if [[ -z "${WHEEL_PATH}" || -z "${WHEEL_SHA}" || -z "${REQUIREMENTS}" ]]; then
  die_json "wheel pin JSON must include path, sha256, and hashed requirements"
fi
if [[ ! -f "${WHEEL_PATH}" ]]; then
  die_json "pinned wheel path missing"
fi
if [[ ! -f "${REQUIREMENTS}" ]]; then
  die_json "hashed vLLM requirements file missing from wheel pin"
fi
verify_sha256 "${WHEEL_PATH}" "${WHEEL_SHA}"

if ! python3 -m pip install --require-hashes -r "${REQUIREMENTS}"; then
  die_json "hashed requirements install failed; no unpinned fallback"
fi

# Production serve: loopback only. Structured outputs via OpenAI-compatible
# extra_body: {"structured_outputs": {"json": <schema>}} or response_format json_schema.
exec python3 -m vllm.entrypoints.cli.main serve "${MODEL}" \
  --host 127.0.0.1 \
  --port "${PORT}" \
  --max-model-len "${VLLM_MAX_MODEL_LEN:-8192}"
