Import-Module Hyper-V
wsl -e true | Out-Null
$parent = "C:\Users\Administrator\Documents\Work\pi-lifecycle\hooks\deploy\sandbox-images\generic_alpine-3.24.1-x86_64-uefi-tiny-r0.vhdx"
Dismount-VHD -Path $parent -ErrorAction SilentlyContinue
Mount-VHD -Path $parent
$diskNum = (Get-VHD -Path $parent).DiskNumber
$pd = "\\.\PhysicalDrive$diskNum"
Write-Output "pd=$pd"
Get-Partition -DiskNumber $diskNum | Format-Table PartitionNumber, Size, Type
wsl.exe --unmount $pd 2>$null | Out-Null
wsl.exe --mount $pd --partition 2 --type ext4 --name hec-alpine-root
Write-Output "mount exit=$LASTEXITCODE"
wsl -e bash -lc "ls /mnt/wsl; echo ---root---; ls /mnt/wsl/hec-alpine-root | head; echo ---conf---; cat /mnt/wsl/hec-alpine-root/etc/tiny-cloud.conf; echo ---inittab---; grep ttyS /mnt/wsl/hec-alpine-root/etc/inittab; echo ---runlevels---; ls /mnt/wsl/hec-alpine-root/etc/runlevels/default"
