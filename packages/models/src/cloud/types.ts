import type {
  CloudDispatch,
  CloudDispatchResult,
  CloudRecoveryLookupKey,
  CloudRecoveryLookupResult,
  DeploymentCapabilities,
  ObjectDigest,
} from "@pi-hec/contracts";

export type GradeACloudRecoveryLookupKey = Extract<
  CloudRecoveryLookupKey,
  { kind: "request-object" | "provider-idempotency-key" }
>;

export type GradeBCloudRecoveryLookupKey = Extract<
  CloudRecoveryLookupKey,
  { kind: "provider-operation-id" }
>;

export type CloudRecoveryAdapter =
  | {
      grade: "A";
      lookupKeys: readonly [
        GradeACloudRecoveryLookupKey["kind"],
        ...GradeACloudRecoveryLookupKey["kind"][],
      ];
      lookup(
        key: GradeACloudRecoveryLookupKey,
        signal: AbortSignal,
      ): Promise<CloudRecoveryLookupResult>;
      cancel?(
        key: GradeACloudRecoveryLookupKey,
        signal: AbortSignal,
      ): Promise<"cancelled" | "completed" | "unknown">;
    }
  | {
      grade: "B";
      lookupKeys: readonly ["provider-operation-id"];
      lookup(
        key: GradeBCloudRecoveryLookupKey,
        signal: AbortSignal,
      ): Promise<CloudRecoveryLookupResult>;
      cancel?(
        key: GradeBCloudRecoveryLookupKey,
        signal: AbortSignal,
      ): Promise<"cancelled" | "completed" | "unknown">;
    }
  | { grade: "C"; lookupKeys: readonly [] };

export interface CloudCompletionAdapter {
  readonly deploymentId: string;
  readonly recovery: CloudRecoveryAdapter;
  capabilities(signal: AbortSignal): Promise<DeploymentCapabilities>;
  completeOnce(dispatch: CloudDispatch, signal: AbortSignal): Promise<CloudDispatchResult>;
}

export type CloudAdapterOptions = {
  capabilities: DeploymentCapabilities;
  fetchImpl?: typeof fetch;
  now?: () => string;
  putBytes?: (bytes: Uint8Array) => ObjectDigest;
};
