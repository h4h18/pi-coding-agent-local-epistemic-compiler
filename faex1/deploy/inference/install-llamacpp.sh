#!/usr/bin/env bash
set -euo pipefail

# llama.cpp 0.4.0 / nightly b10809 Ubuntu Vulkan x64.
# Qwen3.8 (qwen35 / Gated DeltaNet) requires b10419+.
# Release: https://github.com/ggml-org/llama.cpp/releases/tag/b10809
# Stable tag: https://github.com/ggml-org/llama.cpp/releases/tag/v0.4.0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_linux

LLAMA_BUILD="${LLAMA_BUILD:-b10809}"
LLAMA_VERSION="${LLAMA_VERSION:-0.4.0}"
LLAMA_TARBALL="llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-x64.tar.gz"
LLAMA_URL="${LLAMA_URL:-https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${LLAMA_TARBALL}}"
LLAMA_SHA256="${LLAMA_SHA256:-07f029cef440c82c3cff5310641eb6347e5cbcd865a5d88990215058aa049e93}"
INSTALL_ROOT="${LLAMA_CPP_ROOT:-/opt/llama.cpp}"
DOWNLOAD_DIR="${LLAMA_DOWNLOAD_DIR:-/var/cache/pi-hec}"

install -d -m 0755 "${DOWNLOAD_DIR}"
TARBALL_PATH="${DOWNLOAD_DIR}/${LLAMA_TARBALL}"

if [[ ! -f "${TARBALL_PATH}" ]]; then
  curl -fL --retry 5 --retry-all-errors -A "pi-hec/1.0" -o "${TARBALL_PATH}.partial" "${LLAMA_URL}"
  mv "${TARBALL_PATH}.partial" "${TARBALL_PATH}"
fi
verify_sha256 "${TARBALL_PATH}" "sha256:${LLAMA_SHA256}"

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT
tar -xzf "${TARBALL_PATH}" -C "${STAGE}"

SERVER=""
while IFS= read -r -d '' candidate; do
  SERVER="${candidate}"
  break
done < <(find "${STAGE}" -type f -name llama-server -print0)

if [[ -z "${SERVER}" || ! -f "${SERVER}" ]]; then
  die_json "llama-server missing from ${LLAMA_TARBALL}"
fi
chmod 0755 "${SERVER}"

install -d -m 0755 "${INSTALL_ROOT}/bin" "${INSTALL_ROOT}/lib"
SERVER_DIR="$(cd "$(dirname "${SERVER}")" && pwd)"
cp -a "${SERVER_DIR}/." "${INSTALL_ROOT}/bin/"
if [[ -d "${SERVER_DIR}/../lib" ]]; then
  cp -a "${SERVER_DIR}/../lib/." "${INSTALL_ROOT}/lib/"
fi
while IFS= read -r -d '' sofile; do
  cp -a "${sofile}" "${INSTALL_ROOT}/lib/"
done < <(find "${STAGE}" -type f \( -name '*.so' -o -name '*.so.*' \) -print0)

BIN="${INSTALL_ROOT}/bin/llama-server"
if [[ ! -f "${BIN}" ]]; then
  die_json "installed llama-server is not executable"
fi
chmod 0755 "${BIN}"
find "${INSTALL_ROOT}/bin" -type f -name 'llama-*' -exec chmod 0755 {} \;
printf '%s\n' "${LLAMA_VERSION}" > "${INSTALL_ROOT}/version.txt"
printf '%s\n' "${LLAMA_BUILD}" > "${INSTALL_ROOT}/build.txt"

export LD_LIBRARY_PATH="${INSTALL_ROOT}/bin:${INSTALL_ROOT}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
VERSION_OUT="$("${BIN}" --version 2>&1 || true)"
if ! printf '%s\n' "${VERSION_OUT}" | grep -E "${LLAMA_VERSION}|${LLAMA_BUILD}|build ${LLAMA_BUILD#b}" >/dev/null 2>&1; then
  die_json "installed llama-server is not llama.cpp ${LLAMA_VERSION} / ${LLAMA_BUILD}: ${VERSION_OUT}"
fi

printf '{"ok":true,"version":"%s","build":"%s","bin":"%s"}\n' "${LLAMA_VERSION}" "${LLAMA_BUILD}" "${BIN}"
