#!/usr/bin/env bash
set -euo pipefail

# Convert Hugging Face weights to GGUF with llama.cpp 0.4.0 convert_hf_to_gguf.py,
# then hash-verify the converted file before quantize.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_linux

HF_DIR="${1:-}"
OUT_GGUF="${2:-}"
EXPECTED_SHA="${3:-}"
LLAMA_CPP_ROOT="${LLAMA_CPP_ROOT:-}"

if [[ -z "${HF_DIR}" || -z "${OUT_GGUF}" || -z "${EXPECTED_SHA}" ]]; then
  die_json "usage: convert-gguf.sh <hf-dir> <outfile.gguf> <sha256:hex-or-hex>"
fi
if [[ -z "${LLAMA_CPP_ROOT}" || ! -f "${LLAMA_CPP_ROOT}/convert_hf_to_gguf.py" ]]; then
  die_json "LLAMA_CPP_ROOT must point at llama.cpp 0.4.0 with convert_hf_to_gguf.py"
fi

python3 "${LLAMA_CPP_ROOT}/convert_hf_to_gguf.py" "${HF_DIR}" --outfile "${OUT_GGUF}" --outtype f16
verify_sha256 "${OUT_GGUF}" "${EXPECTED_SHA}"

QUANT_OUT="${OUT_GGUF%.gguf}.Q8_0.gguf"
QUANT_SHA="${GGUF_QUANT_SHA256:-}"
"${LLAMA_CPP_ROOT}/build/bin/llama-quantize" "${OUT_GGUF}" "${QUANT_OUT}" Q8_0
if [[ -n "${QUANT_SHA}" ]]; then
  verify_sha256 "${QUANT_OUT}" "${QUANT_SHA}"
else
  die_json "GGUF_QUANT_SHA256 must be set to pin weights after quantization"
fi

printf '{"ok":true,"gguf":"%s","quantized":"%s"}\n' "${OUT_GGUF}" "${QUANT_OUT}"
