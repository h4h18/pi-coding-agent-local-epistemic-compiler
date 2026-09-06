import { assert, property, string } from "fast-check";
import { expect, test } from "vitest";
import {
  assessAll,
  compileVerdictReport,
  decideVerdict,
  evaluateObligation,
  memoryArtifacts,
  signArtifactEnvelope,
  toJsonValue,
} from "../src/index.js";
import {
  BINDINGS,
  OBJECT,
  evidence,
  keyPair,
  obligation,
  observation,
  stableObservations,
} from "./helpers.js";

const CTX = {
  baselineSealObjectDigest: OBJECT,
  candidateManifestObjectDigest: OBJECT,
  environmentSealObjectDigest: OBJECT,
  producerIds: new Set(["generic-process"]),
};

test("LOCAL_MODEL and CLOUD_CLAIM records are inadmissible", () => {
  for (const origin of ["LOCAL_MODEL", "CLOUD_CLAIM"] as const) {
    const record = evidence({ relation: "REFUTES", origin, id: `ev-${origin}` });
    const assessments = assessAll([record], CTX);
    expect(assessments[0]?.state).toBe("INADMISSIBLE");
  }
});

test("LOCAL_MODEL and CLOUD_CLAIM cannot change obligation status in compileVerdictReport", () => {
  const supporting = evidence({
    id: "ev-support",
    relation: "SUPPORTS",
    origin: "VERIFIER",
    observations: stableObservations("PASSED"),
  });
  const poison = [
    evidence({
      id: "ev-model",
      relation: "REFUTES",
      origin: "LOCAL_MODEL",
      observations: stableObservations("FAILED"),
    }),
    evidence({
      id: "ev-cloud",
      relation: "REFUTES",
      origin: "CLOUD_CLAIM",
      observations: stableObservations("FAILED"),
    }),
  ];
  const without = compileVerdictReport({
    plan: { obligations: [obligation()], baselineSealObjectDigest: OBJECT },
    planObjectDigest: OBJECT,
    evidence: [supporting],
    assessments: assessAll([supporting], CTX),
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    unresolvedBlockers: false,
  });
  const withPoison = compileVerdictReport({
    plan: { obligations: [obligation()], baselineSealObjectDigest: OBJECT },
    planObjectDigest: OBJECT,
    evidence: [supporting, ...poison],
    assessments: assessAll([supporting, ...poison], CTX),
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    unresolvedBlockers: false,
  });
  expect(without.verdict).toBe("ACCEPTED");
  expect(withPoison.verdict).toBe(without.verdict);
  expect(withPoison.obligationResults.map((item) => item.status)).toEqual(
    without.obligationResults.map((item) => item.status),
  );
  expect(
    evaluateObligation({ obligation: obligation(), statuses: new Map(), admissible: [supporting] })
      .status,
  ).toBe("PASS");
});

test("inadmissible and mutated evidence cannot flip ACCEPT", () => {
  const supporting = evidence({
    id: "ev-support",
    relation: "SUPPORTS",
    origin: "INDEPENDENT_TOOL",
    observations: stableObservations("PASSED"),
  });
  const assessments = assessAll([supporting], CTX);
  const accepted = compileVerdictReport({
    plan: { obligations: [obligation()], baselineSealObjectDigest: OBJECT },
    planObjectDigest: OBJECT,
    evidence: [supporting],
    assessments,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    unresolvedBlockers: false,
  });
  expect(accepted.verdict).toBe("ACCEPTED");
  const junk = [
    evidence({ id: "ev-local", relation: "REFUTES", origin: "LOCAL_MODEL" }),
    evidence({ id: "ev-cloud", relation: "REFUTES", origin: "CLOUD_CLAIM" }),
    evidence({ id: "ev-mut", relation: "REFUTES", origin: "VERIFIER" }),
  ];
  const junkAssessments = assessAll([...junk, supporting], {
    ...CTX,
    mutatedEvidenceIds: new Set(["ev-mut"]),
  });
  const after = compileVerdictReport({
    plan: { obligations: [obligation()], baselineSealObjectDigest: OBJECT },
    planObjectDigest: OBJECT,
    evidence: [supporting, ...junk],
    assessments: junkAssessments,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    unresolvedBlockers: false,
  });
  expect(after.verdict).toBe("ACCEPTED");
});

test("artifact bytes that do not match their digest are inadmissible", () => {
  const record = evidence({
    id: "ev-bytes",
    relation: "SUPPORTS",
    origin: "INDEPENDENT_TOOL",
    artifactObjectDigests: [OBJECT],
  });
  const assessments = assessAll([record], {
    ...CTX,
    artifacts: memoryArtifacts({ [OBJECT]: "tampered-bytes" }),
  });
  expect(assessments[0]?.state).toBe("INADMISSIBLE");
  expect(assessments[0]?.state === "INADMISSIBLE" ? assessments[0].reasons : []).toContain(
    "artifact-integrity",
  );
});

test("broken observation signature chain is inadmissible", () => {
  const record = evidence({
    id: "ev-sig",
    relation: "SUPPORTS",
    origin: "INDEPENDENT_TOOL",
    observations: stableObservations("PASSED"),
  });
  const tampered = {
    ...record,
    observations: record.observations.map((item) => ({ ...item, state: "FAILED" as const })),
  };
  const assessments = assessAll([tampered], CTX);
  expect(assessments[0]?.state).toBe("INADMISSIBLE");
  expect(assessments[0]?.state === "INADMISSIBLE" ? assessments[0].reasons : []).toContain(
    "signature-chain",
  );
});

test("invalid evidence envelope signature is inadmissible", () => {
  const record = evidence({
    id: "ev-env",
    relation: "SUPPORTS",
    origin: "INDEPENDENT_TOOL",
  });
  const signer = keyPair();
  const other = keyPair();
  const envelope = signArtifactEnvelope(
    "EvidenceRecord",
    toJsonValue(record),
    signer.privateKey,
    signer.keyId,
    signer.certDigest,
    "2026-08-28T00:00:00.000Z",
  );
  const assessments = assessAll([record], {
    ...CTX,
    evidenceEnvelopes: new Map([[record.id, envelope]]),
    envelopePublicKey: other.publicKey,
  });
  expect(assessments[0]?.state).toBe("INADMISSIBLE");
  expect(assessments[0]?.state === "INADMISSIBLE" ? assessments[0].reasons : []).toContain(
    "signature-chain",
  );
});

test("property: LOCAL_MODEL and CLOUD_CLAIM records cannot flip compileVerdictReport", () => {
  const supporting = evidence({
    id: "ev-support",
    relation: "SUPPORTS",
    origin: "VERIFIER",
    observations: stableObservations("PASSED"),
  });
  assert(
    property(string({ minLength: 1, maxLength: 8 }), (salt) => {
      const poison = evidence({
        id: `ev-${salt}`,
        relation: "REFUTES",
        origin: salt.startsWith("c") ? "CLOUD_CLAIM" : "LOCAL_MODEL",
        observations: [observation("FAILED")],
      });
      const base = compileVerdictReport({
        plan: { obligations: [obligation()], baselineSealObjectDigest: OBJECT },
        planObjectDigest: OBJECT,
        evidence: [supporting],
        assessments: assessAll([supporting], CTX),
        subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
        integrityViolation: false,
        sealsValid: true,
        unresolvedBlockers: false,
      });
      const poisoned = compileVerdictReport({
        plan: { obligations: [obligation()], baselineSealObjectDigest: OBJECT },
        planObjectDigest: OBJECT,
        evidence: [supporting, poison],
        assessments: assessAll([supporting, poison], CTX),
        subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
        integrityViolation: false,
        sealsValid: true,
        unresolvedBlockers: false,
      });
      return (
        base.verdict === poisoned.verdict &&
        base.obligationResults[0]?.status === poisoned.obligationResults[0]?.status &&
        decideVerdict({
          obligations: [
            {
              obligationId: obligation().id,
              mandatory: true,
              status: "PASS",
              evidenceIds: ["ev-support"],
              reason: salt,
            },
          ],
          integrityViolation: false,
          sealsValid: true,
          unresolvedBlockers: false,
        }) === "ACCEPTED"
      );
    }),
  );
  expect(BINDINGS.candidateManifestObjectDigest).toBe(OBJECT);
});
