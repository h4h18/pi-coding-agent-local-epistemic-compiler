Import-Module Hyper-V
$parent = "C:\Users\Administrator\Documents\Work\pi-lifecycle\hooks\deploy\sandbox-images\generic_alpine-3.24.1-x86_64-uefi-tiny-r0.vhdx"
$diskNum = (Get-VHD -Path $parent).DiskNumber
$pd = "\\.\PhysicalDrive$diskNum"
wsl.exe --unmount $pd
Dismount-VHD -Path $parent
Write-Output "unmounted disk $diskNum"
