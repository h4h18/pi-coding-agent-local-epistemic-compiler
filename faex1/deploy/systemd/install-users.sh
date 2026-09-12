#!/bin/sh
set -eu
for name in pi-hec-control pi-hec-broker pi-hec-runner pi-hec-worker pi-hec-backup pi-hec-inference; do
  if ! id "$name" >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/pi-hec --shell /usr/sbin/nologin "$name"
  fi
done
usermod -aG render,video pi-hec-inference
if id heir >/dev/null 2>&1; then
  usermod -aG render,video heir
fi
install -d -m 0700 -o pi-hec-control -g pi-hec-control /var/lib/pi-hec/control
install -d -m 0700 -o pi-hec-control -g pi-hec-control /var/lib/pi-hec/cas
install -d -m 0700 -o pi-hec-control -g pi-hec-control /var/lib/pi-hec/index
install -d -m 0700 -o pi-hec-backup -g pi-hec-backup /var/lib/pi-hec/backup
install -d -m 0750 -o pi-hec-inference -g render /var/lib/pi-hec/models
install -d -m 0700 -o pi-hec-broker -g pi-hec-broker /var/lib/pi-hec/broker
install -d -m 0700 -o pi-hec-control -g pi-hec-control /etc/pi-hec
if [ -f /etc/pi-hec/host-config.json ]; then
  chmod 0600 /etc/pi-hec/host-config.json
fi
