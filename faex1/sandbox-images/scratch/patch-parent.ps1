Import-Module Hyper-V
$ErrorActionPreference = "Stop"
$images = Split-Path -Parent $PSScriptRoot
$parent = Join-Path $images "generic_alpine-3.24.1-x86_64-uefi-tiny-r0.vhdx"
$patchPath = Join-Path $PSScriptRoot "patch-guest.sh"

function ConvertTo-WslPath([string]$WinPath) {
  $full = [System.IO.Path]::GetFullPath($WinPath)
  $drive = $full.Substring(0, 1).ToLowerInvariant()
  $rest = $full.Substring(2).Replace('\', '/')
  return "/mnt/$drive$rest"
}

wsl.exe --shutdown
Start-Sleep -Seconds 2
wsl -e true | Out-Null
Dismount-VHD -Path $parent -ErrorAction SilentlyContinue
Mount-VHD -Path $parent
$diskNum = (Get-VHD -Path $parent).DiskNumber
$pd = "\\.\PhysicalDrive$diskNum"
Write-Output "pd=$pd"
wsl.exe --unmount $pd 2>$null | Out-Null
wsl.exe --mount $pd --partition 2 --type ext4 --name hec-alpine-root
if ($LASTEXITCODE -ne 0) { throw "wsl-mount-failed" }
$patch = @'
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
'@
Set-Content -Path $patchPath -Value $patch -Encoding ascii -NoNewline
$wslPatch = ConvertTo-WslPath $patchPath
wsl -e bash -lc "sed -i 's/\r$//' $wslPatch && bash $wslPatch"
if ($LASTEXITCODE -ne 0) { throw "guest-patch-failed" }
wsl.exe --unmount $pd
Dismount-VHD -Path $parent
Write-Output UNMOUNTED_OK
