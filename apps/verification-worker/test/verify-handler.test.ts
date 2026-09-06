import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import type { EvidenceRecord, ObjectDigest } from "@pi-hec/contracts";
import { memoryHost, observationSignature, signArtifactEnvelope, toJsonValue } from "@pi-hec/verification";
import { verifyCandidate } from "../src/index.js";

const OBJECT = ("sha256:" + "ab".repeat(32)) as ObjectDigest;
const TS = "2026-08-28T00:00:00.000Z";
const OBL = ("obl_" + "b".repeat(52));

function keys(keyId: string) {
  const pair = generateKeyPairSync("ed25519");
  const spki = Buffer.from(pair.publicKey.export({ type: "spki", format: "der" }));
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    keyId,
    certDigest: (`sha256:${createHash("sha256").update(spki).digest("hex")}`) as ObjectDigest,
  };
}

test("verifyCandidate assesses evidence and returns a signed ACCEPTED VerdictReport", async () => {
  const control = keys("control-1");
  const verifier = keys("verifier-1");
  const host = memoryHost({ "src/app.ts": "export const n = 1;\n" });
  const bindings = {
    baselineSealObjectDigest: OBJECT,
    environmentSealObjectDigest: OBJECT,
    snapshotId: "snap_01234567-89ab-7cde-8f01-23456789abcd" as const,
    snapshotRootDigest: OBJECT,
    candidateManifestObjectDigest: OBJECT,
  };
  const plan = {
    schemaVersion: 1 as const,
    planId: "plan-worker",
    revision: 0,
    baselineSealObjectDigest: OBJECT,
    requirements: [],
    obligations: [
      {
        id: OBL,
        requirementIds: [("req_" + "a".repeat(52)) as `req_${string}`],
        claim: "feature holds",
        claimMode: "UNIVERSAL" as const,
        kind: "FUNCTIONAL" as const,
        mandatory: true,
        sourceRefs: [],
        prerequisites: [],
      },
    ],
    checks: [],
    baselineSupplementObjectDigests: [],
  };
  const envelope = signArtifactEnvelope(
    "VerificationPlan",
    toJsonValue(plan),
    control.privateKey,
    control.keyId,
    control.certDigest,
    TS,
  );
  const supporting: EvidenceRecord = {
    schemaVersion: 1,
    id: "ev-worker-1",
    obligationId: OBL,
    relation: "SUPPORTS",
    origin: "INDEPENDENT_TOOL",
    independenceGroup: "g1",
    oracle: "EXPLICIT_EXPECTATION",
    baselineSealObjectDigest: OBJECT,
    subject: { kind: "CANDIDATE", candidateManifestObjectDigest: OBJECT },
    producerId: "generic-process",
    producerVersionObjectDigest: OBJECT,
    environmentSealObjectDigest: OBJECT,
    observations: [
      observationSignature({ attempt: 1, state: "PASSED", durationMs: 10 }),
      observationSignature({ attempt: 2, state: "PASSED", durationMs: 10 }),
      observationSignature({ attempt: 3, state: "PASSED", durationMs: 10 }),
    ],
    artifactObjectDigests: [],
  };
  const result = await verifyCandidate({
    planEnvelope: envelope,
    controlPublicKey: control.publicKey,
    verifierPrivateKey: verifier.privateKey,
    verifierKeyId: verifier.keyId,
    verifierCertDigest: verifier.certDigest,
    signedAt: TS,
    evidenceRecords: [supporting],
    host,
    bindings,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    sealsValid: true,
  });
  expect(result.envelope.schemaName).toBe("VerdictReport");
  expect(result.envelope.signatures).toHaveLength(1);
  expect(result.report.verdict).toBe("ACCEPTED");
  expect(result.report.obligationResults[0]?.status).toBe("PASS");
});
