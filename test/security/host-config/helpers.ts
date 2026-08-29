import type { HostConfig } from "@pi-hec/contracts";
import { sha256Utf8, type ObjectDigest } from "@pi-hec/contracts";

export const POLICY_DIGEST = sha256Utf8("task25-retention") as ObjectDigest;
export const BACKUP_DIGEST = sha256Utf8("task25-backup-policy") as ObjectDigest;

export function sampleHostConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    schemaVersion: 1,
    configRevision: 1,
    deploymentSecurityProfile: "SINGLE_HOST",
    control: {
      listenAddress: "127.0.0.1",
      databasePath: "C:/hec/control.sqlite",
      casRoot: "C:/hec/cas",
      indexRoot: "C:/hec/index",
      tlsIdentityRef: "tls-control",
      trustedClientCaRef: "ca-clients",
    },
    independentServices: {},
    localDeployments: [],
    cloudDeployments: [],
    safetyProfiles: [
      {
        id: "default",
        cpuMillis: 1000,
        memoryBytes: 1_048_576,
        processCount: 8,
        diskBytes: 1_048_576,
        wallClockMillis: 1000,
        stdoutBytes: 65_536,
        stderrBytes: 65_536,
      },
    ],
    retentionPolicyObjectDigest: POLICY_DIGEST,
    backupPolicyObjectDigest: BACKUP_DIGEST,
    ...overrides,
  };
}
