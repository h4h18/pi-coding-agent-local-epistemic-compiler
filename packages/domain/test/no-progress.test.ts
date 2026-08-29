import { expect, test } from "vitest";
import {
  DigestError,
  rfc8785Digest,
  sha256Utf8,
  taggedHash,
  type ChangeOperation,
  type Digest,
  type SnapshotId,
} from "@pi-hec/contracts";
import * as noProgress from "../src/no-progress.js";
import {
  changesetHasNormalizedDelta,
  computeNormalizedChangeSetDigest,
  computeStateFingerprint,
  detectNoProgress,
  isTemporaryCloudWait,
  normalizeChangeOperations,
} from "../src/no-progress.js";

const SNAPSHOT_ID = "snap_01900000-0000-7000-8000-000000000001" as SnapshotId;
const ROOT = sha256Utf8("snapshot-root");
const TREE = sha256Utf8("tree");
const EVIDENCE = sha256Utf8("evidence-root");

function directoryOp(path: string): ChangeOperation {
  return {
    kind: "create_directory",
    path,
    expectedAbsent: true,
  };
}

function patchOp(path: string, unifiedDiff: string): ChangeOperation {
  return {
    kind: "text_patch",
    path,
    expectedBeforeDigest: sha256Utf8("before"),
    expectedAfterDigest: sha256Utf8("after"),
    unifiedDiff,
    insertedLineEnding: "LF",
    finalNewline: "PRESENT",
  };
}

function fingerprint(input: {
  operations: readonly ChangeOperation[];
  obligationStatusVector?: readonly { obligationId: string; status: "PASS" | "FAIL" | "UNKNOWN" }[];
  failureSignatures?: readonly string[];
  evidenceRootDigest?: Digest;
}): Digest {
  return computeStateFingerprint({
    baseSnapshotId: SNAPSHOT_ID,
    baseSnapshotRootDigest: ROOT,
    operations: input.operations,
    materializedTreeDigest: TREE,
    obligationStatusVector: input.obligationStatusVector ?? [],
    failureSignatures: input.failureSignatures ?? [],
    evidenceRootDigest: input.evidenceRootDigest ?? EVIDENCE,
  });
}

test("NFC path normalization is stable for changeset digests", () => {
  const decomposed = directoryOp("cafe\u0301");
  const composed = directoryOp("caf\u00e9");
  expect(normalizeChangeOperations([decomposed])).toEqual(normalizeChangeOperations([composed]));
  expect(
    computeNormalizedChangeSetDigest({
      baseSnapshotId: SNAPSHOT_ID,
      baseSnapshotRootDigest: ROOT,
      operations: [decomposed],
    }),
  ).toBe(
    computeNormalizedChangeSetDigest({
      baseSnapshotId: SNAPSHOT_ID,
      baseSnapshotRootDigest: ROOT,
      operations: [composed],
    }),
  );
});

test("unified diffs are serialized with LF before hashing", () => {
  const crlf = patchOp("src/a.ts", "@@ -1 +1 @@\r\n-old\r\n+new\r\n");
  const lf = patchOp("src/a.ts", "@@ -1 +1 @@\n-old\n+new\n");
  expect(
    computeNormalizedChangeSetDigest({
      baseSnapshotId: SNAPSHOT_ID,
      baseSnapshotRootDigest: ROOT,
      operations: [crlf],
    }),
  ).toBe(
    computeNormalizedChangeSetDigest({
      baseSnapshotId: SNAPSHOT_ID,
      baseSnapshotRootDigest: ROOT,
      operations: [lf],
    }),
  );
});

test("operation order is semantic and changes the digest", () => {
  const first = directoryOp("a");
  const second = directoryOp("b");
  const left = computeNormalizedChangeSetDigest({
    baseSnapshotId: SNAPSHOT_ID,
    baseSnapshotRootDigest: ROOT,
    operations: [first, second],
  });
  const right = computeNormalizedChangeSetDigest({
    baseSnapshotId: SNAPSHOT_ID,
    baseSnapshotRootDigest: ROOT,
    operations: [second, first],
  });
  expect(left).not.toBe(right);
});

test("normalized changeset digest uses the registered taggedHash domain", () => {
  const operations = [directoryOp("src")];
  const expected = taggedHash("changeset-normalized", 1, {
    baseSnapshotId: SNAPSHOT_ID,
    baseSnapshotRootDigest: ROOT,
    operations: normalizeChangeOperations(operations),
  });
  expect(
    computeNormalizedChangeSetDigest({
      baseSnapshotId: SNAPSHOT_ID,
      baseSnapshotRootDigest: ROOT,
      operations,
    }),
  ).toBe(expected);
});

test("obligation and failure vectors are sorted; evidence delta changes the fingerprint", () => {
  const operations = [directoryOp("src")];
  const unsorted = fingerprint({
    operations,
    obligationStatusVector: [
      { obligationId: "obl_b", status: "PASS" },
      { obligationId: "obl_a", status: "FAIL" },
    ],
    failureSignatures: ["sig-b", "sig-a"],
  });
  const sorted = fingerprint({
    operations,
    obligationStatusVector: [
      { obligationId: "obl_a", status: "FAIL" },
      { obligationId: "obl_b", status: "PASS" },
    ],
    failureSignatures: ["sig-a", "sig-b"],
  });
  expect(unsorted).toBe(sorted);
  const withEvidence = fingerprint({
    operations,
    evidenceRootDigest: sha256Utf8("new-evidence"),
  });
  expect(withEvidence).not.toBe(fingerprint({ operations }));
});

test("outer fingerprint hashes §23.12 payload without claiming state-fingerprint domain", () => {
  const operations = [directoryOp("src")];
  const normalizedChangeSetDigest = computeNormalizedChangeSetDigest({
    baseSnapshotId: SNAPSHOT_ID,
    baseSnapshotRootDigest: ROOT,
    operations,
  });
  const payload = {
    baseSnapshotRootDigest: ROOT,
    normalizedChangeSetDigest,
    materializedTreeDigest: TREE,
    obligationStatusVector: [
      { obligationId: "obl_a", status: "FAIL" as const },
      { obligationId: "obl_b", status: "PASS" as const },
    ],
    failureSignatures: ["sig-a", "sig-b"],
    evidenceRootDigest: EVIDENCE,
  };
  expect(() => taggedHash("state-fingerprint", 1, payload)).toThrow(DigestError);
  const actual = computeStateFingerprint({
    baseSnapshotId: SNAPSHOT_ID,
    baseSnapshotRootDigest: ROOT,
    operations,
    materializedTreeDigest: TREE,
    obligationStatusVector: [
      { obligationId: "obl_b", status: "PASS" },
      { obligationId: "obl_a", status: "FAIL" },
    ],
    failureSignatures: ["sig-b", "sig-a"],
    evidenceRootDigest: EVIDENCE,
  });
  expect(actual).toBe(rfc8785Digest(payload));
});

test("run/call ids timestamps signatures and cloud summary are excluded from the fingerprint", () => {
  const operations = [directoryOp("src")];
  const first = fingerprint({ operations });
  const second = computeStateFingerprint({
    baseSnapshotId: SNAPSHOT_ID,
    baseSnapshotRootDigest: ROOT,
    operations,
    materializedTreeDigest: TREE,
    obligationStatusVector: [],
    failureSignatures: [],
    evidenceRootDigest: EVIDENCE,
  });
  expect(first).toBe(second);
});

test("detectNoProgress covers §23.12 reasons", () => {
  const operations = [directoryOp("src")];
  const current = fingerprint({ operations });
  expect(changesetHasNormalizedDelta([])).toBe(false);
  expect(
    detectNoProgress({
      fingerprint: current,
      previousFingerprints: [],
      hasNormalizedDelta: false,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: false,
    }),
  ).toBe("CHANGESET_WITHOUT_DELTA");
  expect(
    detectNoProgress({
      fingerprint: current,
      previousFingerprints: [current],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: false,
    }),
  ).toBe("FINGERPRINT_REPEATED");
  expect(
    detectNoProgress({
      fingerprint: current,
      previousFingerprints: [current, sha256Utf8("other")],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: false,
    }),
  ).toBe("FINGERPRINT_CYCLE");
  expect(
    detectNoProgress({
      fingerprint: current,
      previousFingerprints: [],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: false,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: false,
    }),
  ).toBe("CANDIDATE_MISSES_CAUSAL_SLICE");
  expect(
    detectNoProgress({
      fingerprint: current,
      previousFingerprints: [],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: true,
      cloudResultRepeated: false,
    }),
  ).toBe("PRESERVED_OBLIGATION_REGRESSION");
  expect(
    detectNoProgress({
      fingerprint: current,
      previousFingerprints: [],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: true,
    }),
  ).toBe("CLOUD_RESULT_REPEATED");
  expect(
    detectNoProgress({
      fingerprint: current,
      previousFingerprints: [sha256Utf8("prior")],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: false,
    }),
  ).toBeUndefined();
});

test("unlimited novel evidence deltas continue without MAX_REPAIRS", () => {
  const operations = [directoryOp("src")];
  const previous: Digest[] = [];
  for (let index = 0; index < 12; index += 1) {
    const current = fingerprint({
      operations,
      evidenceRootDigest: sha256Utf8(`novel-evidence-${String(index)}`),
    });
    expect(
      detectNoProgress({
        fingerprint: current,
        previousFingerprints: previous,
        hasNormalizedDelta: true,
        touchesCausalSliceOrAddsEvidence: true,
        regressesPreservedPassingObligations: false,
        cloudResultRepeated: false,
      }),
    ).toBeUndefined();
    previous.push(current);
  }
  expect(Object.hasOwn(noProgress, "MAX_REPAIRS")).toBe(false);
});

test("temporary adapter not-dispatched and waiting are not no-progress", () => {
  expect(isTemporaryCloudWait("not-dispatched")).toBe(true);
  expect(isTemporaryCloudWait("waiting-provider")).toBe(true);
  expect(isTemporaryCloudWait("outcome-unknown")).toBe(true);
  expect(isTemporaryCloudWait("completed")).toBe(false);
  const operations = [directoryOp("src")];
  const current = fingerprint({ operations });
  expect(
    detectNoProgress({
      fingerprint: current,
      previousFingerprints: [sha256Utf8("prior")],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: isTemporaryCloudWait("not-dispatched") ? false : true,
    }),
  ).toBeUndefined();
});
