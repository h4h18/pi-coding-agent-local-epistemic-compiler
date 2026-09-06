import type { DeploymentCapabilities } from "@pi-hec/contracts";
import { recoveryAdapterFor, type CloudRecoveryAdapter } from "@pi-hec/models";

export function selectDeploymentBeforeDispatch(input: {
  userOrder: readonly string[];
  records: readonly DeploymentCapabilities[];
  requiredNativeTokens: number;
  requiredMaxOutputTokens: number;
  dispatched: boolean;
}): DeploymentCapabilities | undefined {
  if (input.dispatched) {
    return undefined;
  }
  for (const deploymentId of input.userOrder) {
    const record = input.records.find((item) => item.deploymentId === deploymentId);
    if (record === undefined) {
      continue;
    }
    if (record.context.nativeTokens < input.requiredNativeTokens) {
      continue;
    }
    const maxOutput = record.context.maxOutputTokens;
    if (maxOutput !== null && maxOutput < input.requiredMaxOutputTokens) {
      continue;
    }
    return record;
  }
  return undefined;
}

export function recoveryForCapabilities(
  capabilities: DeploymentCapabilities,
): CloudRecoveryAdapter {
  return recoveryAdapterFor(capabilities);
}

export function recoveryMatchesCapabilities(
  capabilities: DeploymentCapabilities,
  recovery: CloudRecoveryAdapter,
): boolean {
  if (recovery.grade !== capabilities.recovery.grade) {
    return false;
  }
  const kinds = [...capabilities.recovery.lookupKeyKinds];
  if (recovery.lookupKeys.length !== kinds.length) {
    return false;
  }
  for (let index = 0; index < kinds.length; index += 1) {
    if (recovery.lookupKeys[index] !== kinds[index]) {
      return false;
    }
  }
  return true;
}
