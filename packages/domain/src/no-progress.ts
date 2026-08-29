import {
  rfc8785Digest,
  taggedHash,
  type ChangeOperation,
  type Digest,
  type DomainDigest,
  type SnapshotId,
} from "@pi-hec/contracts";
import { asJsonValue } from "./events.js";

export type ObligationStatusEntry = {
  readonly obligationId: string;
  readonly status: "PASS" | "FAIL" | "UNKNOWN";
};

export type ProgressFingerprintInput = {
  readonly baseSnapshotId: SnapshotId;
  readonly baseSnapshotRootDigest: Digest;
  readonly operations: readonly ChangeOperation[];
  readonly materializedTreeDigest: Digest;
  readonly obligationStatusVector: readonly ObligationStatusEntry[];
  readonly failureSignatures: readonly string[];
  readonly evidenceRootDigest: Digest;
};

export type NoProgressReason =
  | "FINGERPRINT_REPEATED"
  | "FINGERPRINT_CYCLE"
  | "CHANGESET_WITHOUT_DELTA"
  | "CANDIDATE_MISSES_CAUSAL_SLICE"
  | "PRESERVED_OBLIGATION_REGRESSION"
  | "CLOUD_RESULT_REPEATED";

function compareUtf8(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizePath(path: string): string {
  return path.normalize("NFC");
}

function normalizeUnifiedDiff(diff: string): string {
  return diff.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function normalizeChangeOperation(operation: ChangeOperation): ChangeOperation {
  switch (operation.kind) {
    case "text_patch":
      return {
        ...operation,
        path: normalizePath(operation.path),
        unifiedDiff: normalizeUnifiedDiff(operation.unifiedDiff),
      };
    case "create_text":
      return { ...operation, path: normalizePath(operation.path) };
    case "create_directory":
      return { ...operation, path: normalizePath(operation.path) };
    case "write_binary":
      return { ...operation, path: normalizePath(operation.path) };
    case "delete":
      return { ...operation, path: normalizePath(operation.path) };
    case "delete_directory":
      return { ...operation, path: normalizePath(operation.path) };
    case "move":
      return {
        ...operation,
        from: normalizePath(operation.from),
        to: normalizePath(operation.to),
      };
    case "set_git_mode":
      return { ...operation, path: normalizePath(operation.path) };
    case "symlink":
      return { ...operation, path: normalizePath(operation.path) };
    default: {
      const exhaustive: never = operation;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function normalizeChangeOperations(
  operations: readonly ChangeOperation[],
): ChangeOperation[] {
  return operations.map(normalizeChangeOperation);
}

export function computeNormalizedChangeSetDigest(input: {
  baseSnapshotId: SnapshotId;
  baseSnapshotRootDigest: Digest;
  operations: readonly ChangeOperation[];
}): DomainDigest<"changeset-normalized"> {
  return taggedHash(
    "changeset-normalized",
    1,
    asJsonValue({
      baseSnapshotId: input.baseSnapshotId,
      baseSnapshotRootDigest: input.baseSnapshotRootDigest,
      operations: normalizeChangeOperations(input.operations),
    }),
  );
}

export function computeStateFingerprint(input: ProgressFingerprintInput): Digest {
  const obligationStatusVector = [...input.obligationStatusVector].sort((left, right) =>
    compareUtf8(left.obligationId, right.obligationId),
  );
  const failureSignatures = [...input.failureSignatures].sort(compareUtf8);
  const payload = {
    baseSnapshotRootDigest: input.baseSnapshotRootDigest,
    normalizedChangeSetDigest: computeNormalizedChangeSetDigest({
      baseSnapshotId: input.baseSnapshotId,
      baseSnapshotRootDigest: input.baseSnapshotRootDigest,
      operations: input.operations,
    }),
    materializedTreeDigest: input.materializedTreeDigest,
    obligationStatusVector,
    failureSignatures,
    evidenceRootDigest: input.evidenceRootDigest,
  };
  // Task 2 taggedHash("state-fingerprint") projects { projectId, runId, state, stateVersion,
  // artifactRoleDigests } and rejects these §23.12 fields. Digest domains cannot be extended here,
  // and no registered projection matches this payload, so the outer fingerprint is RFC8785+SHA-256
  // of the §23.12 object without claiming the state-fingerprint registry domain.
  return rfc8785Digest(payload);
}

export function changesetHasNormalizedDelta(operations: readonly ChangeOperation[]): boolean {
  return normalizeChangeOperations(operations).length > 0;
}

export function detectNoProgress(input: {
  fingerprint: Digest;
  previousFingerprints: readonly Digest[];
  hasNormalizedDelta: boolean;
  touchesCausalSliceOrAddsEvidence: boolean;
  regressesPreservedPassingObligations: boolean;
  cloudResultRepeated: boolean;
}): NoProgressReason | undefined {
  if (!input.hasNormalizedDelta) {
    return "CHANGESET_WITHOUT_DELTA";
  }
  const previous = input.previousFingerprints;
  const last = previous[previous.length - 1];
  if (last === input.fingerprint) {
    return "FINGERPRINT_REPEATED";
  }
  if (previous.includes(input.fingerprint)) {
    return "FINGERPRINT_CYCLE";
  }
  if (!input.touchesCausalSliceOrAddsEvidence) {
    return "CANDIDATE_MISSES_CAUSAL_SLICE";
  }
  if (input.regressesPreservedPassingObligations) {
    return "PRESERVED_OBLIGATION_REGRESSION";
  }
  if (input.cloudResultRepeated) {
    return "CLOUD_RESULT_REPEATED";
  }
  return undefined;
}

export type TemporaryCloudWaitKind = "not-dispatched" | "waiting-provider" | "outcome-unknown";

export function isTemporaryCloudWait(kind: string): kind is TemporaryCloudWaitKind {
  return kind === "not-dispatched" || kind === "waiting-provider" || kind === "outcome-unknown";
}
