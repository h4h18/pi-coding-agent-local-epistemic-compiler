import { expect, test } from "vitest";
import { classifyFlake, compileVerdictReport, evaluateObligation, pairedFlake, sprtBounds } from "../src/index.js";
import { DIGEST, OBJECT, SNAP, evidence, obligation, observation, stableObservations } from "./helpers.js";

test("passing retry does not drop a prior fail observation", () => {
  const observations = [observation("FAILED", 1), observation("PASSED", 2)];
  expect(observations).toHaveLength(2);
  expect(observations[0]?.state).toBe("FAILED");
  expect(classifyFlake(observations)).toBe("unknown-instability");
});

test("one isolated FAIL is not stable-fail without minObservations", () => {
  expect(classifyFlake([observation("FAILED", 1)])).toBe("unknown-instability");
  const bounds = sprtBounds();
  expect(bounds.acceptH1).toBeGreaterThan(0);
  expect(bounds.acceptH0).toBeLessThan(0);
  const result = evaluateObligation({
    obligation: obligation(),
    statuses: new Map(),
    admissible: [
      evidence({
        relation: "REFUTES",
        origin: "INDEPENDENT_TOOL",
        observations: [observation("FAILED", 1)],
      }),
    ],
  });
  expect(result.status).toBe("UNKNOWN");
});

test("stable candidate-only failure is stable-fail", () => {
  expect(
    pairedFlake({
      baseline: stableObservations("PASSED"),
      candidate: stableObservations("FAILED"),
    }),
  ).toBe("stable-fail");
});

test("pairedFlake feeds evaluateObligation", () => {
  const result = evaluateObligation({
    obligation: obligation(),
    statuses: new Map(),
    admissible: [
      evidence({
        id: "ev-base",
        relation: "SUPPORTS",
        origin: "VERIFIER",
        subject: { kind: "BASELINE", snapshotId: SNAP, snapshotRootDigest: DIGEST },
        observations: [observation("FAILED", 1), observation("PASSED", 2), observation("PASSED", 3)],
      }),
      evidence({
        id: "ev-cand",
        relation: "SUPPORTS",
        origin: "INDEPENDENT_TOOL",
        observations: [observation("FAILED", 1), observation("PASSED", 2), observation("PASSED", 3)],
      }),
    ],
  });
  expect(result.status).toBe("UNKNOWN");
});

test("identical instability is unknown", () => {
  const mixed = [observation("FAILED", 1), observation("PASSED", 2)];
  expect(pairedFlake({ baseline: mixed, candidate: mixed })).toBe("unknown-instability");
});

test("candidate-only stable fail is FAIL and REJECTED", () => {
  const candidateFail = evidence({
    id: "ev-cand-only",
    relation: "REFUTES",
    origin: "INDEPENDENT_TOOL",
    observations: stableObservations("FAILED"),
  });
  const evaluation = evaluateObligation({
    obligation: obligation(),
    statuses: new Map(),
    admissible: [candidateFail],
  });
  expect(evaluation.status).toBe("FAIL");
  expect(evaluation.failAttribution).toBe("CANDIDATE");
  expect(evaluation.failCertainty).toBe("CONFIRMED");
  const report = compileVerdictReport({
    plan: { obligations: [obligation()], baselineSealObjectDigest: OBJECT },
    planObjectDigest: OBJECT,
    evidence: [candidateFail],
    assessments: [
      { evidenceId: candidateFail.id, state: "ADMISSIBLE", policyRevisionObjectDigest: OBJECT },
    ],
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    unresolvedBlockers: false,
  });
  expect(report.obligationResults[0]?.status).toBe("FAIL");
  expect(report.verdict).toBe("REJECTED");
});

test("same stable failure on baseline and candidate is UNKNOWN not REJECTED", () => {
  const candidateFail = evidence({
    id: "ev-cand-same",
    relation: "REFUTES",
    origin: "INDEPENDENT_TOOL",
    observations: stableObservations("FAILED"),
  });
  const baselineFail = evidence({
    id: "ev-base-same",
    relation: "REFUTES",
    origin: "INDEPENDENT_TOOL",
    subject: { kind: "BASELINE", snapshotId: SNAP, snapshotRootDigest: DIGEST },
    observations: stableObservations("FAILED"),
  });
  const evaluation = evaluateObligation({
    obligation: obligation(),
    statuses: new Map(),
    admissible: [candidateFail, baselineFail],
  });
  expect(evaluation.status).toBe("UNKNOWN");
  const report = compileVerdictReport({
    plan: { obligations: [obligation()], baselineSealObjectDigest: OBJECT },
    planObjectDigest: OBJECT,
    evidence: [candidateFail, baselineFail],
    assessments: [
      { evidenceId: candidateFail.id, state: "ADMISSIBLE", policyRevisionObjectDigest: OBJECT },
      { evidenceId: baselineFail.id, state: "ADMISSIBLE", policyRevisionObjectDigest: OBJECT },
    ],
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    unresolvedBlockers: false,
  });
  expect(report.obligationResults[0]?.status).toBe("UNKNOWN");
  expect(report.verdict).toBe("INCONCLUSIVE");
});
