export type WindowsIsolation = "hyperv";

export type DifferencingVhdPlan = {
  isolation: WindowsIsolation;
  parentPath: string;
  childPath: string;
  generation: 2;
  network: "none";
  memoryBytes: number;
};

export type IsolationSelection =
  | { ok: true; isolation: WindowsIsolation }
  | {
      ok: false;
      reason: "process-isolation-insufficient" | "wsl2-not-boundary" | "job-object-insufficient";
    };

export function selectWindowsIsolation(requested: string): IsolationSelection {
  switch (requested) {
    case "hyperv":
    case "hyper-v":
    case "hyperv-container":
      return { ok: true, isolation: "hyperv" };
    case "process":
      return { ok: false, reason: "process-isolation-insufficient" };
    case "wsl2":
      return { ok: false, reason: "wsl2-not-boundary" };
    case "job-object":
      return { ok: false, reason: "job-object-insufficient" };
    default:
      return { ok: false, reason: "process-isolation-insufficient" };
  }
}

export function buildDifferencingVhdPlan(input: {
  parentPath: string;
  childPath: string;
  memoryBytes: number;
}): DifferencingVhdPlan {
  return {
    isolation: "hyperv",
    parentPath: input.parentPath,
    childPath: input.childPath,
    generation: 2,
    network: "none",
    memoryBytes: input.memoryBytes,
  };
}

export const HYPERV_PROBE_SCRIPT =
  "Get-Service -Name vmms -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status";

export type HyperVCreatePlan = DifferencingVhdPlan & {
  vmName: string;
  comPipePath: string;
  seedPath: string;
  networkSwitch?: string;
};

export const INTERNAL_SWITCH_NAME = "pi-hec-sb-net";
export const PROXY_HOST_IP = "10.255.254.1";
export const GUEST_FABRIC_IP = "10.255.254.2";
export const PROXY_PORT = 3128;

export function ensureInternalSwitchCommands(
  switchName: string,
  hostIp: string,
): readonly string[] {
  return [ensureSandboxSwitchCommand(switchName, hostIp)];
}

export function ensureSandboxSwitchCommand(preferredName: string, hostIp: string): string {
  const preferred = quotePowerShell(preferredName);
  const ip = hostIp.replaceAll("'", "''");
  return [
    "Set-Service -Name NetSetupSvc -StartupType Manual -ErrorAction SilentlyContinue",
    "Start-Service -Name NetSetupSvc -ErrorAction SilentlyContinue",
    `$preferred = ${preferred}`,
    "$switch = Get-VMSwitch -Name $preferred -ErrorAction SilentlyContinue",
    "if ($null -eq $switch) { New-VMSwitch -Name $preferred -SwitchType Internal -ErrorAction Stop | Out-Null; $switch = Get-VMSwitch -Name $preferred -ErrorAction SilentlyContinue }",
    "if ($null -eq $switch -or $switch.Name -ne $preferred) { throw 'sandbox-switch-missing' }",
    "$osName = 'vEthernet (' + $preferred + ')'",
    `$has = Get-NetIPAddress -InterfaceAlias $osName -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq '${ip}' }`,
    `if ($null -eq $has) { New-NetIPAddress -InterfaceAlias $osName -IPAddress '${ip}' -PrefixLength 24 -ErrorAction SilentlyContinue | Out-Null }`,
    `$has2 = Get-NetIPAddress -InterfaceAlias $osName -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq '${ip}' }`,
    "if ($null -eq $has2) { throw 'sandbox-switch-ip-missing' }",
    "Write-Output ('HEC_SWITCH ' + $preferred)",
  ].join("; ");
}

export function hypervCreateCommands(plan: HyperVCreatePlan): readonly string[] {
  const vm = quotePowerShell(plan.vmName);
  const nic =
    plan.networkSwitch === undefined
      ? `Get-VMNetworkAdapter -VMName ${vm} | Disconnect-VMNetworkAdapter`
      : `Get-VMNetworkAdapter -VMName ${vm} | Connect-VMNetworkAdapter -SwitchName ${quotePowerShell(plan.networkSwitch)}`;
  return [
    `New-VHD -Path ${quotePowerShell(plan.childPath)} -ParentPath ${quotePowerShell(plan.parentPath)} -Differencing`,
    `New-VM -Name ${vm} -VHDPath ${quotePowerShell(plan.childPath)} -Generation ${String(plan.generation)} -MemoryStartupBytes ${String(plan.memoryBytes)}`,
    `Set-VM -Name ${vm} -CheckpointType Disabled -AutomaticStartAction Nothing`,
    `Set-VMFirmware -VMName ${vm} -EnableSecureBoot Off`,
    nic,
    `Add-VMHardDiskDrive -VMName ${vm} -Path ${quotePowerShell(plan.seedPath)}`,
    `Set-VMComPort -VMName ${vm} -Number 1 -Path ${quotePowerShell(plan.comPipePath)}`,
    `Start-VM -Name ${vm}`,
  ];
}

export function hypervProxyAclCommands(
  vmName: string,
  proxyIp: string,
  proxyPort: number,
): readonly string[] {
  const vm = quotePowerShell(vmName);
  const ip = quotePowerShell(proxyIp);
  return [
    `Add-VMNetworkAdapterExtendedAcl -VMName ${vm} -Action Allow -Direction Outbound -RemoteIPAddress ${ip} -RemotePort ${String(proxyPort)} -Protocol TCP -Weight 100 -Stateful $true`,
    `Add-VMNetworkAdapterExtendedAcl -VMName ${vm} -Action Deny -Direction Outbound -Weight 1`,
    `Add-VMNetworkAdapterExtendedAcl -VMName ${vm} -Action Deny -Direction Inbound -Weight 1`,
  ];
}

export function hypervTeardownCommands(vmName: string): readonly string[] {
  const vm = quotePowerShell(vmName);
  return [
    `Stop-VM -Name ${vm} -TurnOff -Force -ErrorAction SilentlyContinue`,
    `Remove-VM -Name ${vm} -Force -ErrorAction SilentlyContinue`,
    `$deadline = (Get-Date).AddSeconds(15); while ((Get-Date) -lt $deadline -and (Get-VM -Name ${vm} -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 250 }`,
  ];
}

export function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
