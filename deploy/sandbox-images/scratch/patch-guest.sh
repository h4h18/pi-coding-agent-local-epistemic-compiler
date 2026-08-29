set -euo pipefail
root=/mnt/wsl/hec-alpine-root
conf="$root/etc/tiny-cloud.conf"
ls "$root/etc" >/dev/null
sed -i 's/^#CLOUD=auto/CLOUD=nocloud/' "$conf"
if ! grep -q '^CLOUD=nocloud' "$conf"; then
  printf '\nCLOUD=nocloud\n' >> "$conf"
fi
sed -i 's/^#SKIP_INIT_ACTIONS=/SKIP_INIT_ACTIONS=expand_root set_ephemeral_network set_network_interfaces enable_sshd/' "$conf"
rm -f "$root/etc/runlevels/default/networking" "$root/etc/runlevels/default/sshd" "$root/etc/runlevels/default/chronyd"
mkdir -p "$root/etc/local.d"
cat > "$root/etc/local.d/hec.start" << 'EOF'
#!/bin/sh
mkdir -p /media/cidata
mount -t vfat /dev/sdb1 /media/cidata 2>/dev/null || mount -t vfat /dev/sdb /media/cidata 2>/dev/null
if [ -f /media/cidata/user-data ]; then
  exec sh /media/cidata/user-data
fi
EOF
chmod 755 "$root/etc/local.d/hec.start"
if [ -e "$root/etc/init.d/local" ]; then
  ln -sf /etc/init.d/local "$root/etc/runlevels/default/local"
fi
grep -E '^(CLOUD|SKIP_INIT_ACTIONS)=' "$conf"
echo PATCH_OK