param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Node = "node"
)

$ErrorActionPreference = "Stop"
& $Node (Join-Path $RepoRoot "deploy\windows\rotate-mtls.ts") $OutputDir
if ($LASTEXITCODE -ne 0) {
  throw "mTLS rotation failed"
}
icacls $OutputDir /inheritance:r | Out-Null
Get-ChildItem -Path $OutputDir -Filter "*.key.pem" | ForEach-Object {
  icacls $_.FullName /inheritance:r /grant:r "${env:USERNAME}:(R)" | Out-Null
}
