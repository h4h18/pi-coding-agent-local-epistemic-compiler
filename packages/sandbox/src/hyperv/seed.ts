import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecFilePort } from "../protocol.js";
import { quotePowerShell } from "./image-flow.js";

export function seedCreateScript(seedPath: string, stagingDir: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `New-VHD -Path ${quotePowerShell(seedPath)} -SizeBytes 16MB -Dynamic | Out-Null`,
    `Mount-VHD -Path ${quotePowerShell(seedPath)}`,
    "try {",
    "  Start-Sleep -Milliseconds 400",
    `  $diskNum = (Get-VHD -Path ${quotePowerShell(seedPath)}).DiskNumber`,
    "  if ($null -eq $diskNum) { throw 'seed-disk-number-missing' }",
    "  Set-Disk -Number $diskNum -IsOffline $false",
    "  Set-Disk -Number $diskNum -IsReadOnly $false",
    "  Initialize-Disk -Number $diskNum -PartitionStyle MBR -Confirm:$false",
    "  $part = New-Partition -DiskNumber $diskNum -UseMaximumSize -AssignDriveLetter",
    "  try {",
    "    Format-Volume -DriveLetter $part.DriveLetter -FileSystem FAT -NewFileSystemLabel CIDATA -Confirm:$false | Out-Null",
    "  } catch {",
    "    Format-Volume -DriveLetter $part.DriveLetter -FileSystem FAT32 -NewFileSystemLabel CIDATA -Confirm:$false | Out-Null",
    "  }",
    "  $letter = $null",
    "  for ($i = 0; $i -lt 40; $i++) {",
    "    $letter = [string](Get-Partition -DiskNumber $diskNum | Where-Object { $_.DriveLetter } | Select-Object -ExpandProperty DriveLetter)",
    "    if ($letter) { break }",
    "    Start-Sleep -Milliseconds 250",
    "  }",
    "  if (-not $letter) { throw 'seed-drive-letter-missing' }",
    "  $root = $letter.Trim() + ':\\'",
    `  Copy-Item -Force ${quotePowerShell(path.join(stagingDir, "meta-data"))} ($root + 'meta-data')`,
    `  Copy-Item -Force ${quotePowerShell(path.join(stagingDir, "user-data"))} ($root + 'user-data')`,
    `  Copy-Item -Force ${quotePowerShell(path.join(stagingDir, "network-config"))} ($root + 'network-config')`,
    "} finally {",
    `  Dismount-VHD -Path ${quotePowerShell(seedPath)} -ErrorAction SilentlyContinue`,
    "}",
    "",
  ].join("\r\n");
}

export async function createFatFilesVhdx(input: {
  vhdPath: string;
  stagingDir: string;
  files: Readonly<Record<string, string>>;
  exec: ExecFilePort;
}): Promise<void> {
  await mkdir(input.stagingDir, { recursive: true });
  for (const [name, body] of Object.entries(input.files)) {
    await writeFile(path.join(input.stagingDir, name), body, "utf8");
  }
  const ps1Path = path.join(input.stagingDir, "create-fat.ps1");
  const copies = Object.keys(input.files).map(
    (name) =>
      `  Copy-Item -Force ${quotePowerShell(path.join(input.stagingDir, name))} ($root + ${quotePowerShell(name)})`,
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `New-VHD -Path ${quotePowerShell(input.vhdPath)} -SizeBytes 8MB -Dynamic | Out-Null`,
    `Mount-VHD -Path ${quotePowerShell(input.vhdPath)}`,
    "try {",
    "  Start-Sleep -Milliseconds 400",
    `  $diskNum = (Get-VHD -Path ${quotePowerShell(input.vhdPath)}).DiskNumber`,
    "  if ($null -eq $diskNum) { throw 'fat-disk-number-missing' }",
    "  Set-Disk -Number $diskNum -IsOffline $false",
    "  Set-Disk -Number $diskNum -IsReadOnly $false",
    "  Initialize-Disk -Number $diskNum -PartitionStyle MBR -Confirm:$false",
    "  $part = New-Partition -DiskNumber $diskNum -UseMaximumSize -AssignDriveLetter",
    "  try {",
    "    Format-Volume -DriveLetter $part.DriveLetter -FileSystem FAT -NewFileSystemLabel HECINJ -Confirm:$false | Out-Null",
    "  } catch {",
    "    Format-Volume -DriveLetter $part.DriveLetter -FileSystem FAT32 -NewFileSystemLabel HECINJ -Confirm:$false | Out-Null",
    "  }",
    "  $letter = $null",
    "  for ($i = 0; $i -lt 40; $i++) {",
    "    $letter = [string](Get-Partition -DiskNumber $diskNum | Where-Object { $_.DriveLetter } | Select-Object -ExpandProperty DriveLetter)",
    "    if ($letter) { break }",
    "    Start-Sleep -Milliseconds 250",
    "  }",
    "  if (-not $letter) { throw 'fat-drive-letter-missing' }",
    "  $root = $letter.Trim() + ':\\'",
    ...copies,
    "} finally {",
    `  Dismount-VHD -Path ${quotePowerShell(input.vhdPath)} -ErrorAction SilentlyContinue`,
    "}",
    "",
  ].join("\r\n");
  await writeFile(ps1Path, script, "utf8");
  await input.exec(
    "powershell.exe",
    ["-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
    { timeout: 60_000 },
  );
}

export async function createNocloudSeedVhdx(input: {
  seedPath: string;
  stagingDir: string;
  metaData: string;
  userData: string;
  networkConfig: string;
  exec: ExecFilePort;
}): Promise<void> {
  await mkdir(input.stagingDir, { recursive: true });
  await writeFile(path.join(input.stagingDir, "meta-data"), input.metaData, "utf8");
  await writeFile(path.join(input.stagingDir, "user-data"), input.userData.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), "utf8");
  await writeFile(path.join(input.stagingDir, "network-config"), input.networkConfig, "utf8");
  const ps1Path = path.join(input.stagingDir, "create-seed.ps1");
  await writeFile(ps1Path, seedCreateScript(input.seedPath, input.stagingDir), "utf8");
  await input.exec(
    "powershell.exe",
    ["-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
    { timeout: 60_000 },
  );
}
