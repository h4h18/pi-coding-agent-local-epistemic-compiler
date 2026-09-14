#!/usr/bin/env bash
set -euo pipefail

# FA-EX1 production bootstrap: Vulkan llama.cpp 0.4.0 (b10809), Qwen3.8-27B Q4_K_M, control plane.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ ! -f "${REPO_ROOT}/pnpm-workspace.yaml" ]]; then
  echo "faex1/bootstrap.sh must run from a full pi-hec checkout" >&2
  exit 1
fi

LISTEN_HOST="${PI_HEC_LISTEN_HOST:-10.10.10.184}"
NODE_VERSION="${PI_HEC_NODE_VERSION:-24.21.0}"
NODE_TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256="${PI_HEC_NODE_SHA256:-fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6}"
GGUF_URL="${PI_HEC_GGUF_URL:-https://huggingface.co/Distillio/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_K_M.gguf}"
GGUF_SHA256="sha256:e103abf9d914d1d7b2f2592f055f2759a71195c350a01c135f71aaae86bca52b"
GGUF_PATH="/var/lib/pi-hec/models/Qwen3.8-27B-Q4_K_M.gguf"
PNPM_VERSION="${PI_HEC_PNPM_VERSION:-12.0.0}"
CLIENT_USER="${PI_HEC_CLIENT_USER:-heir}"

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo -E env PATH="${PATH}" bash "$0" "$@"
fi

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:${PATH}"
apt-get update

PKGS=(
  ca-certificates curl git xz-utils tar unzip
  python3 build-essential pkg-config
  mesa-vulkan-drivers libvulkan1
  acl openssl binutils
)
for extra in vulkan-tools python3-pip python3-venv python3-full; do
  if apt-cache show "${extra}" >/dev/null 2>&1; then
    PKGS+=("${extra}")
  fi
done
apt-get install -y --no-install-recommends "${PKGS[@]}"

if [[ -d "${REPO_ROOT}" && "${REPO_ROOT}" != "/opt/pi-hec" ]]; then
  mkdir -p /opt/pi-hec
  tar -C "${REPO_ROOT}" \
    --exclude node_modules --exclude dist --exclude target --exclude .git \
    --exclude .superpowers --exclude .cursor \
    -cf - . | tar -C /opt/pi-hec -xf -
  REPO_ROOT="/opt/pi-hec"
fi

find "${REPO_ROOT}/faex1" -type f \( -name '*.sh' -o -name '*.service' -o -name '*.timer' \) \
  -exec sed -i 's/\r$//' {} +
find "${REPO_ROOT}/faex1" -type f -name '*.sh' -exec chmod 0755 {} +

bash "${REPO_ROOT}/faex1/deploy/systemd/install-users.sh"

install -d -m 0755 /usr/local/src /var/cache/pi-hec
if [[ ! -x /usr/local/bin/node ]]; then
  curl -fL --retry 5 -A "pi-hec/1.0" -o "/var/cache/pi-hec/${NODE_TARBALL}" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
  echo "${NODE_SHA256}  /var/cache/pi-hec/${NODE_TARBALL}" | sha256sum -c -
  tar -xJf "/var/cache/pi-hec/${NODE_TARBALL}" -C /usr/local --strip-components=1
fi
hash -r
if [[ ! -x /usr/bin/node ]]; then
  ln -sfn /usr/local/bin/node /usr/bin/node
fi
corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate

bash "${REPO_ROOT}/faex1/deploy/inference/install-llamacpp.sh"

install -d -m 0750 -o pi-hec-inference -g render /var/lib/pi-hec/models
CLIENT_CACHE="/home/${CLIENT_USER}/.cache/pi-hec/Qwen3.8-27B-Q4_K_M.gguf"
GGUF_BYTES="${PI_HEC_GGUF_BYTES:-17772537440}"
if pgrep -f 'curl.*Qwen3.8-27B-Q4_K_M' >/dev/null 2>&1; then
  echo "waiting for in-flight GGUF download" >&2
  while pgrep -f 'curl.*Qwen3.8-27B-Q4_K_M' >/dev/null 2>&1; do
    sleep 10
  done
fi
if [[ ! -f "${CLIENT_CACHE}" && -f "${CLIENT_CACHE}.partial" ]]; then
  cache_bytes="$(stat -c%s "${CLIENT_CACHE}.partial")"
  if [[ "${cache_bytes}" -eq "${GGUF_BYTES}" ]]; then
    mv "${CLIENT_CACHE}.partial" "${CLIENT_CACHE}"
  fi
fi
if [[ ! -f "${GGUF_PATH}" && -f "${CLIENT_CACHE}" ]]; then
  cp -a "${CLIENT_CACHE}" "${GGUF_PATH}"
fi
if [[ ! -f "${GGUF_PATH}" && -f "${CLIENT_CACHE}.partial" ]]; then
  cp -a "${CLIENT_CACHE}.partial" "${GGUF_PATH}.partial"
fi
if [[ ! -f "${GGUF_PATH}" ]]; then
  curl -fL --retry 8 --retry-all-errors -C - -A "pi-hec/1.0" \
    -o "${GGUF_PATH}.partial" "${GGUF_URL}"
  mv "${GGUF_PATH}.partial" "${GGUF_PATH}"
fi
expected_hash="${GGUF_SHA256#sha256:}"
hash_stamp="${GGUF_PATH}.sha256"
gguf_ok=0
if [[ -f "${hash_stamp}" && -f "${GGUF_PATH}" ]]; then
  stamp_hash="$(tr -d '[:space:]' < "${hash_stamp}")"
  gguf_bytes_now="$(stat -c%s "${GGUF_PATH}")"
  if [[ "${stamp_hash}" == "${expected_hash}" && "${gguf_bytes_now}" -eq "${GGUF_BYTES}" ]]; then
    gguf_ok=1
    echo "GGUF hash stamp ok (${expected_hash})"
  fi
fi
if [[ "${gguf_ok}" -ne 1 ]]; then
  actual="$(sha256sum -- "${GGUF_PATH}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected_hash}" ]]; then
    echo "GGUF hash mismatch; deleting and retrying once" >&2
    rm -f "${GGUF_PATH}" "${GGUF_PATH}.partial" "${hash_stamp}"
    curl -fL --retry 8 --retry-all-errors -C - -A "pi-hec/1.0" \
      -o "${GGUF_PATH}.partial" "${GGUF_URL}"
    mv "${GGUF_PATH}.partial" "${GGUF_PATH}"
    actual="$(sha256sum -- "${GGUF_PATH}" | awk '{print $1}')"
    if [[ "${actual}" != "${expected_hash}" ]]; then
      echo "GGUF hash mismatch after retry" >&2
      exit 1
    fi
  fi
  printf '%s\n' "${actual}" > "${hash_stamp}"
  chmod 0640 "${hash_stamp}"
fi
chown pi-hec-inference:render "${GGUF_PATH}" "${hash_stamp}" 2>/dev/null || chown pi-hec-inference:render "${GGUF_PATH}"
chmod 0640 "${GGUF_PATH}"

cd "${REPO_ROOT}"
pnpm install
pnpm exec tsc -b faex1/apps/control-plane faex1/apps/secret-broker

if [[ ! -f /etc/pi-hec/host-config.json ]]; then
  PI_HEC_ETC=/etc/pi-hec \
    PI_HEC_LISTEN_HOST="${LISTEN_HOST}" \
    /usr/local/bin/node "${REPO_ROOT}/faex1/apps/control-plane/dist/bootstrap-host.js"
fi

chown -R pi-hec-control:pi-hec-control /etc/pi-hec
chmod 0750 /etc/pi-hec /etc/pi-hec/pki
chmod 0600 /etc/pi-hec/host-config.json /etc/pi-hec/host-config.key.pem /etc/pi-hec/keys.json
chmod 0640 /etc/pi-hec/host-config.pub.pem /etc/pi-hec/identities.json
find /etc/pi-hec/pki -type f -name '*.key.pem' -exec chmod 0600 {} \;
find /etc/pi-hec/pki -type f \( -name '*.crt.pem' -o -name '*.sign.pub.pem' \) -exec chmod 0640 {} \;
chmod 0640 /etc/pi-hec/pki/worker.key.pem /etc/pi-hec/pki/worker.sign.key.pem /etc/pi-hec/pki/admin.sign.pub.pem
usermod -aG pi-hec-control pi-hec-worker
usermod -aG pi-hec-control pi-hec-broker
chown -R pi-hec-control:pi-hec-control /var/lib/pi-hec/control /var/lib/pi-hec/cas /var/lib/pi-hec/index
chown -R pi-hec-broker:pi-hec-broker /var/lib/pi-hec/broker

if id "${CLIENT_USER}" >/dev/null 2>&1; then
  CLIENT_HOME="$(getent passwd "${CLIENT_USER}" | cut -d: -f6)"
  install -d -m 0700 -o "${CLIENT_USER}" -g "${CLIENT_USER}" "${CLIENT_HOME}/.pi-hec/pki"
  for name in ca.crt.pem admin.crt.pem admin.key.pem admin.sign.key.pem \
              broker.crt.pem broker.key.pem broker.sign.key.pem \
              runner.crt.pem runner.key.pem runner.sign.key.pem \
              pi-agent.crt.pem pi-agent.key.pem pi-agent.sign.key.pem; do
    install -m 0640 -o "${CLIENT_USER}" -g "${CLIENT_USER}" \
      "/etc/pi-hec/pki/${name}" "${CLIENT_HOME}/.pi-hec/pki/${name}"
  done
  chmod 0600 "${CLIENT_HOME}/.pi-hec/pki/"*.key.pem
fi

install -m 0644 "${REPO_ROOT}/faex1/deploy/systemd/pi-hec-inference.service" /etc/systemd/system/pi-hec-inference.service
install -m 0644 "${REPO_ROOT}/faex1/deploy/systemd/pi-hec-control.service" /etc/systemd/system/pi-hec-control.service
install -m 0644 "${REPO_ROOT}/faex1/deploy/systemd/pi-hec-worker.service" /etc/systemd/system/pi-hec-worker.service
install -m 0644 "${REPO_ROOT}/faex1/deploy/systemd/pi-hec-broker.service" /etc/systemd/system/pi-hec-broker.service
sed -i 's/\r$//' /etc/systemd/system/pi-hec-inference.service \
  /etc/systemd/system/pi-hec-control.service \
  /etc/systemd/system/pi-hec-worker.service \
  /etc/systemd/system/pi-hec-broker.service
systemctl daemon-reload
systemctl enable --now pi-hec-inference.service
systemctl enable --now pi-hec-control.service
systemctl enable --now pi-hec-worker.service
systemctl enable --now pi-hec-broker.service

ok_models=0
for _ in $(seq 1 360); do
  if curl -sf http://127.0.0.1:8000/v1/models >/tmp/pi-hec-models.json; then
    ok_models=1
    break
  fi
  sleep 10
done
if [[ "${ok_models}" -ne 1 ]]; then
  echo "inference /v1/models did not become ready" >&2
  journalctl -u pi-hec-inference -n 120 --no-pager >&2 || true
  exit 1
fi
if ! python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path("/tmp/pi-hec-models.json").read_text(encoding="utf-8"))
ids = [item.get("id") for item in payload.get("data", [])]
if "Qwen/Qwen3.8-27B" not in ids and not any("Qwen3.8-27B" in str(item) for item in ids):
    raise SystemExit(f"Qwen3.8-27B missing from /v1/models: {ids}")
print(json.dumps({"ok": True, "models": ids}))
PY
then
  exit 1
fi

curl -sf http://127.0.0.1:8000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen/Qwen3.8-27B","messages":[{"role":"user","content":"Reply with the single word PONG."}],"max_tokens":32,"temperature":0,"chat_template_kwargs":{"enable_thinking":false},"reasoning_effort":"none"}' \
  | python3 -c 'import json,sys; body=json.load(sys.stdin); msg=body["choices"][0]["message"]; text=(msg.get("content") or "")+(msg.get("reasoning_content") or ""); assert "PONG" in text.upper(), text; print(json.dumps({"ok":True,"content":text}))'

if ! openssl s_client -connect "${LISTEN_HOST}:8443" -tls1_3 \
  -CAfile /etc/pi-hec/pki/ca.crt.pem \
  -cert /etc/pi-hec/pki/admin.crt.pem \
  -key /etc/pi-hec/pki/admin.key.pem \
  </dev/null >/tmp/pi-hec-tls.txt 2>&1; then
  echo "control-plane mTLS handshake failed to connect" >&2
  cat /tmp/pi-hec-tls.txt >&2 || true
  journalctl -u pi-hec-control -n 80 --no-pager >&2 || true
  exit 1
fi
if ! grep -q "Verify return code: 0" /tmp/pi-hec-tls.txt; then
  echo "control-plane mTLS certificate verify failed" >&2
  cat /tmp/pi-hec-tls.txt >&2 || true
  journalctl -u pi-hec-control -n 80 --no-pager >&2 || true
  exit 1
fi

printf '{"ok":true,"inference":"http://127.0.0.1:8000/v1","control":"https://%s:8443","model":"Qwen/Qwen3.8-27B","contextPerSlot":262144,"parallelSlots":4}\n' "${LISTEN_HOST}"
