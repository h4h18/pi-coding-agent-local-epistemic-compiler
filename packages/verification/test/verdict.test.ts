import { expect, test } from "vitest";
import {
  compileVerdictReport,
  decideVerdict,
  evaluateObligation,
  type ObligationEvaluation,
} from "../src/index.js";
import { BINDINGS, OBL, OBJECT, SNAP, evidence, obligation, observation } from "./helpers.js";

function evaluation(status: ObligationEvaluation["status"], extra: Partial<ObligationEvaluation> = {}): ObligationEvaluation {
  return {
    obligationId: OBL,
    mandatory: true,
    status,
    evidenceIds: ["ev-1"],
    reason: status,
    ...extra,
  };
}

test("integrity violation rejects even when obligations pass", () => {
  expect(
    decideVerdict({
      obligations: [evaluation("PASS")],
      integrityViolation: true,
      sealsValid: true,
      unresolvedBlockers: false,
    }),
  ).toBe("REJECTED");
});

test("probable-only counterevidence cannot reject", () => {
  expect(
    decideVerdict({
      obligations: [
        evaluation("UNKNOWN", {
          failAttribution: "CANDIDATE",
          failCertainty: "PROBABLE",
          failCode: "PATCH_FUNCTIONAL",
        }),
      ],
      integrityViolation: false,
      sealsValid: true,
      unresolvedBlockers: false,
    }),
  ).toBe("INCONCLUSIVE");
});

test("missing mandatory proof is INCONCLUSIVE not PASS", () => {
  expect(
    decideVerdict({
      obligations: [evaluation("UNKNOWN")],
      integrityViolation: false,
      sealsValid: true,
      unresolvedBlockers: false,
    }),
  ).toBe("INCONCLUSIVE");
});

test("all mandatory PASS with valid seals is ACCEPTED", () => {
  expect(
    decideVerdict({
      obligations: [evaluation("PASS")],
      integrityViolation: false,
      sealsValid: true,
      unresolvedBlockers: false,
    }),
  ).toBe("ACCEPTED");
});

test("confirmed candidate FAIL rejects", () => {
  expect(
    decideVerdict({
      obligations: [
        evaluation("FAIL", {
          failAttribution: "CANDIDATE",
          failCertainty: "CONFIRMED",
        }),
      ],
      integrityViolation: false,
      sealsValid: true,
      unresolvedBlockers: false,
    }),
  ).toBe("REJECTED");
});

test("invalid seals block ACCEPT", () => {
  expect(
    decideVerdict({
      obligations: [evaluation("PASS")],
      integrityViolation: false,
      sealsValid: false,
      unresolvedBlockers: false,
    }),
  ).toBe("INCONCLUSIVE");
});

test("evaluateObligation FAIL requires confirmed candidate-attributable counterevidence", () => {
  const fail = evaluateObligation({
    obligation: obligation(),
    statuses: new Map(),
    admissible: [
      evidence({
        relation: "REFUTES",
        origin: "INDEPENDENT_TOOL",
        observations: [observation("FAILED"), observation("FAILED"), observation("FAILED")],
      }),
    ],
  });
  expect(fail.status).toBe("FAIL");
  expect(fail.failCertainty).toBe("CONFIRMED");
  expect(fail.failAttribution).toBe("CANDIDATE");
});

test("evaluateObligation treats CANDIDATE_TEST refutes as probable not FAIL", () => {
  const result = evaluateObligation({
    obligation: obligation(),
    statuses: new Map(),
    admissible: [
      evidence({
        relation: "REFUTES",
        origin: "CANDIDATE_TEST",
        observations: [observation("FAILED")],
      }),
    ],
  });
  expect(result.status).toBe("UNKNOWN");
  expect(result.failCertainty).toBe("PROBABLE");
});

test("evaluateObligation never PASSes on missing evidence", () => {
  const result = evaluateObligation({
    obligation: obligation(),
    statuses: new Map(),
    admissible: [],
  });
  expect(result.status).toBe("UNKNOWN");
});

test("coverage example SUPPORTS cannot PASS a UNIVERSAL MUST", () => {
  const example = evidence({
    relation: "SUPPORTS",
    origin: "INDEPENDENT_TOOL",
    producerId: "coverage",
    observations: [observation("PASSED"), observation("PASSED"), observation("PASSED")],
  });
  const universal = evaluateObligation({
    obligation: obligation({ claimMode: "UNIVERSAL" }),
    statuses: new Map(),
    admissible: [example],
  });
  expect(universal.status).toBe("UNKNOWN");
  const existential = evaluateObligation({
    obligation: obligation({ claimMode: "EXISTENTIAL" }),
    statuses: new Map(),
    admissible: [example],
  });
  expect(existential.status).toBe("PASS");
});

test("compileVerdictReport maps integrity violation to REJECTED", () => {
  const report = compileVerdictReport({
    plan: { obligations: [obligation()], baselineSealObjectDigest: OBJECT },
    planObjectDigest: OBJECT,
    evidence: [
      evidence({
        relation: "SUPPORTS",
        origin: "VERIFIER",
        observations: [observation("PASSED"), observation("PASSED"), observation("PASSED")],
      }),
    ],
    assessments: [
      {
        evidenceId: "ev-1",
        state: "ADMISSIBLE",
        policyRevisionObjectDigest: OBJECT,
      },
    ],
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: true,
    sealsValid: true,
    unresolvedBlockers: false,
  });
  expect(report.verdict).toBe("REJECTED");
  expect(report.failures.some((item) => item.code === "EVIDENCE_TAMPER")).toBe(true);
  expect(BINDINGS.snapshotId).toBe(SNAP);
});
