#!/usr/bin/env bash
set -euo pipefail

BIND_HOST="127.0.0.1"

die_json() {
  local message="$1"
  printf '{"ok":false,"reason":%s}\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$message")" >&2
  exit 1
}

require_linux() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    die_json "FA-EX1 inference scripts require native Linux"
  fi
}

require_loopback_host() {
  if [[ "${BIND_HOST}" != "127.0.0.1" ]]; then
    die_json "inference bind address must be 127.0.0.1"
  fi
}

sha256_file() {
  sha256sum -- "$1" | awk '{print $1}'
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(sha256_file "$file")"
  if [[ "sha256:${actual}" != "${expected}" && "${actual}" != "${expected}" ]]; then
    die_json "hash mismatch for ${file}"
  fi
}
