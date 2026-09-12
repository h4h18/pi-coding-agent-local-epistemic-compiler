#!/bin/sh
set -eu
for name in pi-hec-control pi-hec-broker pi-hec-runner pi-hec-worker pi-hec-backup; do
  if ! id "$name" >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/pi-hec --shell /usr/sbin/nologin "$name"
  fi
done
install -d -m 0700 -o pi-hec-control -g pi-hec-control /var/lib/pi-hec/control
install -d -m 0700 -o pi-hec-control -g pi-hec-control /var/lib/pi-hec/cas
install -d -m 0700 -o pi-hec-backup -g pi-hec-backup /var/lib/pi-hec/backup
install -d -m 0700 -o pi-hec-control -g pi-hec-control /etc/pi-hec
chmod 0600 /etc/pi-hec/host-config.json
