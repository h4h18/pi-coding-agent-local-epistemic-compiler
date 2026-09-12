param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Node = "node"
)

$ErrorActionPreference = "Stop"
$backup = Join-Path $RepoRoot "deploy\fa-ex1\backup\run-scheduled.ts"
$rotate = Join-Path $RepoRoot "deploy\windows\rotate-mtls.ts"

function Register-HecTask {
  param(
    [string]$Name,
    [string]$Kind,
    [string]$Schedule,
    [int]$Modifier = 1,
    [string]$StartTime = "03:15"
  )
  $arg = "`"$backup`" $Kind"
  schtasks /Create /F /TN $Name /TR "$Node $arg" /SC $Schedule /MO $Modifier /ST $StartTime | Out-Null
}

Register-HecTask -Name "pi-hec-backup-hourly" -Kind "hourly" -Schedule "HOURLY" -Modifier 1 -StartTime "00:00"
Register-HecTask -Name "pi-hec-integrity-daily" -Kind "daily-integrity" -Schedule "DAILY" -Modifier 1 -StartTime "03:15"
Register-HecTask -Name "pi-hec-cas-scrub-weekly" -Kind "weekly-cas-scrub" -Schedule "WEEKLY" -Modifier 1 -StartTime "04:00"
Register-HecTask -Name "pi-hec-full-read-monthly" -Kind "monthly-full-read" -Schedule "MONTHLY" -Modifier 1 -StartTime "05:00"
Register-HecTask -Name "pi-hec-restore-drill-quarterly" -Kind "quarterly-restore-drill" -Schedule "MONTHLY" -Modifier 3 -StartTime "06:00"
schtasks /Create /F /TN "pi-hec-backup-on-terminal" /TR "$Node `"$backup`" on-terminal" /SC ONCE /ST 00:00 /Z | Out-Null
schtasks /Create /F /TN "pi-hec-rotate-mtls" /TR "$Node `"$rotate`" `"$RepoRoot\var\pi-hec\pki`"" /SC MONTHLY /MO 1 /ST 02:00 | Out-Null
