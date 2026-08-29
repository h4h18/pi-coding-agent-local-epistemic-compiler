param()

$ErrorActionPreference = "Stop"
Write-Output "Windows GPU inventory helper (not the FA-EX1 production path)"

$hip = [string]$env:HIP_PATH
$rocm = [string]$env:ROCM_PATH
if ($hip.Trim().Length -gt 0 -or $rocm.Trim().Length -gt 0) {
  Write-Output "HIP_PATH or ROCM_PATH is set; record the raw values without concluding support"
} else {
  Write-Output "HIP_PATH and ROCM_PATH are empty"
}

Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM | Format-Table -AutoSize

try {
  & nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
} catch {
  Write-Output "nvidia-smi was not available"
}
