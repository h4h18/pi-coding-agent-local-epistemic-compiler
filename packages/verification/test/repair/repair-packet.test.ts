import { expect, test } from "vitest";
import { Compile } from "typebox/compile";
import { RepairPacketSchema, objectDigestFromBytes } from "@pi-hec/contracts";
import { buildRepairPacket, isRepairEligible } from "../../src/repair-packet.js";
import {
  ANALYST_PROSE,
  CANDIDATE,
  CHECK_A,
  CHECK_B,
  CHECK_C,
  OBJECT,
  OBL_FAIL,
  OBL_FAIL_B,
  OBL_PASS,
  RUN,
  SNAP,
  admissibleAssessment,
  checkNode,
  failEvidence,
  failObligation,
  failureSignature,
  inadmissibleAssessment,
  jsonContains,
  packetContainsProse,
  passObligation,
  planWith,
  rejectedReport,
  repoRef,
  utf8Artifact,
} from "./helpers.js";

const PACKET = Compile(RepairPacketSchema);

test("repair packet is refused until every independent check has a result", () => {
  const plan = planWith(
    [checkNode(CHECK_A, [OBL_FAIL]), checkNode(CHECK_B, [OBL_PASS])],
    [failObligation(), passObligation()],
  );
  const result = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report: rejectedReport(),
    checkResults: new Map([[CHECK_A, "FAIL"]]),
    failureArtifacts: [utf8Artifact("test log line")],
  });
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected refusal");
  }
  expect(result.code).toBe("INCOMPLETE_INDEPENDENT_CHECKS");
});

test("first FAIL does not skip an independent sibling that already has a result", () => {
  const plan = planWith(
    [checkNode(CHECK_A, [OBL_FAIL]), checkNode(CHECK_B, [OBL_PASS]), checkNode(CHECK_C, [OBL_FAIL], [CHECK_A])],
    [failObligation(), passObligation()],
  );
  const result = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report: rejectedReport(),
    checkResults: new Map([
      [CHECK_A, "FAIL"],
      [CHECK_B, "PASS"],
    ]),
    failureArtifacts: [utf8Artifact("test log line")],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.code);
  }
  expect(PACKET.Check(result.packet)).toBe(true);
});

test("passing obligations are listed as prohibited regressions", () => {
  const plan = planWith(
    [checkNode(CHECK_A, [OBL_FAIL]), checkNode(CHECK_B, [OBL_PASS])],
    [failObligation(), passObligation()],
  );
  const result = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report: rejectedReport(),
    checkResults: new Map([
      [CHECK_A, "FAIL"],
      [CHECK_B, "PASS"],
    ]),
    failureArtifacts: [utf8Artifact("test log line")],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.code);
  }
  expect(result.packet.preservedPassingObligationIds).toEqual([OBL_PASS]);
  expect(result.packet.prohibitedRegressionObligationIds).toEqual([OBL_PASS]);
  expect(result.packet.unresolvedObligationIds).toEqual([OBL_FAIL]);
});

test("digest-only inline failure artifact is not dispatchable", () => {
  const plan = planWith([checkNode(CHECK_A, [OBL_FAIL])], [failObligation()]);
  const result = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report: rejectedReport({
      obligationResults: [{ obligationId: OBL_FAIL, status: "FAIL", evidenceIds: ["ev-fail"], reason: "failed" }],
    }),
    checkResults: new Map([[CHECK_A, "FAIL"]]),
    failureArtifacts: [
      {
        objectDigest: OBJECT,
        mediaType: "text/plain",
        sourceRefs: [repoRef("src/fail.ts")],
        content: { encoding: "digest-only" },
      },
    ],
  });
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected digest-only refusal");
  }
  expect(result.code).toBe("DIGEST_ONLY_FAILURE_ARTIFACT");
});

test("utf-8 and base64 inline failure bytes are dispatchable", () => {
  const plan = planWith([checkNode(CHECK_A, [OBL_FAIL])], [failObligation()]);
  const utf8 = "exact failure log";
  const raw = Buffer.from("binary-fail", "utf8");
  const utf8Result = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report: rejectedReport({
      obligationResults: [{ obligationId: OBL_FAIL, status: "FAIL", evidenceIds: ["ev-fail"], reason: "failed" }],
    }),
    checkResults: new Map([[CHECK_A, "FAIL"]]),
    failureArtifacts: [utf8Artifact(utf8)],
  });
  expect(utf8Result.ok).toBe(true);
  if (!utf8Result.ok) {
    throw new Error(utf8Result.code);
  }
  expect(utf8Result.packet.inlineFailureArtifacts[0]?.content).toEqual({ encoding: "utf-8", text: utf8 });
  expect(utf8Result.packet.inlineFailureArtifacts[0]?.objectDigest).toBe(
    objectDigestFromBytes(Buffer.from(utf8, "utf8")),
  );
  const b64Result = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report: rejectedReport({
      obligationResults: [{ obligationId: OBL_FAIL, status: "FAIL", evidenceIds: ["ev-fail"], reason: "failed" }],
    }),
    checkResults: new Map([[CHECK_A, "FAIL"]]),
    failureArtifacts: [
      {
        objectDigest: objectDigestFromBytes(raw),
        mediaType: "application/octet-stream",
        sourceRefs: [repoRef("src/fail.ts")],
        content: { encoding: "base64", base64: raw.toString("base64") },
      },
    ],
  });
  expect(b64Result.ok).toBe(true);
  if (!b64Result.ok) {
    throw new Error(b64Result.code);
  }
  expect(b64Result.packet.inlineFailureArtifacts[0]?.content.encoding).toBe("base64");
});

test("full replacement ChangeSet is required", () => {
  const plan = planWith([checkNode(CHECK_A, [OBL_FAIL])], [failObligation()]);
  const result = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report: rejectedReport({
      obligationResults: [{ obligationId: OBL_FAIL, status: "FAIL", evidenceIds: ["ev-fail"], reason: "failed" }],
    }),
    checkResults: new Map([[CHECK_A, "FAIL"]]),
    failureArtifacts: [utf8Artifact("log")],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.code);
  }
  expect(result.packet.requiredResponse).toBe("FULL_REPLACEMENT_CHANGESET");
  expect(PACKET.Check(result.packet)).toBe(true);
});

test("shared generic artifact with unrelated refs cannot cover a second failure", () => {
  const secondFail = failObligation(OBL_FAIL_B, "src/fail-b.ts");
  const failSigB = failureSignature(OBL_FAIL_B, "second candidate test failed");
  const plan = planWith(
    [checkNode(CHECK_A, [OBL_FAIL]), checkNode(CHECK_B, [OBL_FAIL_B])],
    [failObligation(), secondFail],
  );
  const report = rejectedReport({
    obligationResults: [
      { obligationId: OBL_FAIL, status: "FAIL", evidenceIds: ["ev-fail"], reason: "candidate test failed" },
      { obligationId: OBL_FAIL_B, status: "FAIL", evidenceIds: ["ev-fail-b"], reason: "second candidate test failed" },
    ],
    failures: [
      {
        code: "PATCH_FUNCTIONAL",
        attribution: "CANDIDATE",
        repairOwner: "CLOUD",
        certainty: "CONFIRMED",
        obligationIds: [OBL_FAIL],
        evidenceIds: ["ev-fail"],
        failureSignature: failureSignature(OBL_FAIL, "candidate test failed"),
        summary: "candidate test failed",
      },
      {
        code: "PATCH_FUNCTIONAL",
        attribution: "CANDIDATE",
        repairOwner: "CLOUD",
        certainty: "CONFIRMED",
        obligationIds: [OBL_FAIL_B],
        evidenceIds: ["ev-fail-b"],
        failureSignature: failSigB,
        summary: "second candidate test failed",
      },
    ],
  });
  const shared = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report,
    checkResults: new Map([
      [CHECK_A, "FAIL"],
      [CHECK_B, "FAIL"],
    ]),
    failureArtifacts: [utf8Artifact("generic log", [repoRef("src/unrelated.ts")])],
  });
  expect(shared.ok).toBe(false);
  if (shared.ok) {
    throw new Error("expected refusal");
  }
  expect(shared.code).toBe("DIGEST_ONLY_FAILURE_ARTIFACT");
  const matched = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report,
    checkResults: new Map([
      [CHECK_A, "FAIL"],
      [CHECK_B, "FAIL"],
    ]),
    failureArtifacts: [
      utf8Artifact("first failure log", [repoRef("src/fail.ts")]),
      utf8Artifact("second failure log", [repoRef("src/fail-b.ts")]),
    ],
  });
  expect(matched.ok).toBe(true);
  if (!matched.ok) {
    throw new Error(matched.code);
  }
  expect(matched.packet.inlineFailureArtifacts).toHaveLength(2);
  const bound = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report,
    checkResults: new Map([
      [CHECK_A, "FAIL"],
      [CHECK_B, "FAIL"],
    ]),
    failureArtifacts: [
      { ...utf8Artifact("first bound log", [repoRef("src/unrelated.ts")]), evidenceIds: ["ev-fail"] },
      { ...utf8Artifact("second bound log", [repoRef("src/other.ts")]), obligationIds: [OBL_FAIL_B] },
    ],
  });
  expect(bound.ok).toBe(true);
  if (!bound.ok) {
    throw new Error(bound.code);
  }
});

test("CONFIRMED CLOUD failure needs admissible independently reproduced evidence", () => {
  const plan = planWith([checkNode(CHECK_A, [OBL_FAIL])], [failObligation()]);
  const confirmed = rejectedReport({
    evidenceAssessments: [inadmissibleAssessment("ev-fail", "LOCAL_MODEL")],
  });
  expect(
    isRepairEligible({
      report: confirmed,
      evidence: [failEvidence("LOCAL_MODEL")],
      plan,
    }),
  ).toBe(false);
  expect(
    isRepairEligible({
      report: rejectedReport({ evidenceAssessments: [] }),
      evidence: [failEvidence("VERIFIER")],
      plan,
    }),
  ).toBe(false);
  expect(
    isRepairEligible({
      report: rejectedReport({
        evidenceAssessments: [admissibleAssessment()],
      }),
      evidence: [failEvidence("VERIFIER")],
      plan,
    }),
  ).toBe(true);
  expect(
    isRepairEligible({
      report: rejectedReport({
        evidenceAssessments: [admissibleAssessment()],
      }),
      evidence: [failEvidence("INDEPENDENT_TOOL")],
      plan,
    }),
  ).toBe(true);
  const missingOnly = rejectedReport({
    verdict: "INCONCLUSIVE",
    obligationResults: [
      { obligationId: OBL_FAIL, status: "UNKNOWN", evidenceIds: [], reason: "missing admissible supporting evidence" },
    ],
    failures: [],
    evidenceAssessments: [admissibleAssessment()],
    workflowState: "REPAIRABLE",
  });
  expect(isRepairEligible({ report: missingOnly, evidence: [failEvidence("VERIFIER")], plan })).toBe(false);
  const blockingUnknown = rejectedReport({
    evidenceAssessments: [admissibleAssessment()],
    obligationResults: [
      { obligationId: OBL_PASS, status: "PASS", evidenceIds: ["ev-pass"], reason: "held" },
      { obligationId: OBL_FAIL, status: "FAIL", evidenceIds: ["ev-fail"], reason: "candidate test failed" },
      { obligationId: OBL_FAIL_B, status: "UNKNOWN", evidenceIds: [], reason: "missing admissible supporting evidence" },
    ],
  });
  const planWithUnknown = planWith(
    [checkNode(CHECK_A, [OBL_FAIL]), checkNode(CHECK_B, [OBL_FAIL_B])],
    [failObligation(), failObligation(OBL_FAIL_B, "src/fail-b.ts")],
  );
  expect(
    isRepairEligible({
      report: blockingUnknown,
      evidence: [failEvidence("VERIFIER")],
      plan: planWithUnknown,
    }),
  ).toBe(false);
});

test("local finding statements never enter RepairPacket", () => {
  const plan = planWith([checkNode(CHECK_A, [OBL_FAIL])], [failObligation()]);
  const result = buildRepairPacket({
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan,
    report: rejectedReport({
      obligationResults: [{ obligationId: OBL_FAIL, status: "FAIL", evidenceIds: ["ev-fail"], reason: "failed" }],
    }),
    checkResults: new Map([[CHECK_A, "FAIL"]]),
    failureArtifacts: [utf8Artifact("junit log")],
    localFindingStatements: [ANALYST_PROSE],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.code);
  }
  expect(packetContainsProse(result.packet, ANALYST_PROSE)).toBe(false);
  expect(jsonContains(result.packet, ANALYST_PROSE)).toBe(false);
});
