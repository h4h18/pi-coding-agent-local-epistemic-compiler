import {
  taggedHash,
  type CheckNode,
  type EvidenceRecord,
  type ProofObligation,
  type RepairPacket,
  type SourceRef,
  type VerificationPlan,
  type VerdictReport,
} from "@pi-hec/contracts";
import { CHECK, DIGEST, OBJECT, OBL, REQ, RUN, SNAP, evidence, obligation } from "../helpers.js";

export const ANALYST_PROSE = "LOCAL_ANALYST_SAYS_THE_BUG_IS_IN_WIDGET_FACTORY_PARSE";
export const CANDIDATE = "candidate_01234567-89ab-7cde-8f01-23456789abcd";
export const OBL_PASS = ("obl_" + "c".repeat(52));
export const OBL_FAIL = ("obl_" + "d".repeat(52));
export const OBL_FAIL_B = ("obl_" + "h".repeat(52));
export const CHECK_A = ("check_" + "e".repeat(52));
export const CHECK_B = ("check_" + "f".repeat(52));
export const CHECK_C = ("check_" + "g".repeat(52));

export function repoRef(path: string): SourceRef {
  return {
    origin: "repository",
    sourceKind: "repository",
    snapshotId: SNAP,
    artifactObjectDigest: OBJECT,
    path,
    range: { kind: "whole" },
    quoteDigest: DIGEST,
  };
}

export function jsonContains(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(needle);
}

export function packetContainsProse(packet: RepairPacket, needle: string): boolean {
  return jsonContains(packet, needle);
}

export function failureSignature(obligationId: string, message: string): VerdictReport["failures"][number]["failureSignature"] {
  return taggedHash("failure-signature", 1, {
    obligationIds: [obligationId],
    attribution: "CANDIDATE",
    normalizedMessage: message,
  });
}

export function checkNode(
  id: CheckNode["id"],
  obligationIds: readonly ProofObligation["id"][],
  dependencies: readonly CheckNode["id"][] = [],
): CheckNode {
  return {
    id,
    obligationIds: [...obligationIds],
    subject: "CANDIDATE",
    recipe: { intrinsicCheckId: `intrinsic-${id}`, configurationObjectDigest: OBJECT },
    dependencies: [...dependencies],
    mandatory: true,
    approval: "AUTO",
  };
}

export function planWith(checks: readonly CheckNode[], obligations: readonly ProofObligation[]): VerificationPlan {
  return {
    schemaVersion: 1,
    planId: "plan-repair",
    revision: 0,
    baselineSealObjectDigest: OBJECT,
    requirements: [],
    obligations: [...obligations],
    checks: [...checks],
    baselineSupplementObjectDigests: [],
  };
}

export function rejectedReport(overrides: Partial<VerdictReport> = {}): VerdictReport {
  const failSig = failureSignature(OBL_FAIL, "candidate test failed");
  const evidenceRootDigest = taggedHash("verification-evidence-root", 1, {
    evidenceRecordObjectDigests: [OBJECT],
  });
  return {
    schemaVersion: 1,
    verdict: "REJECTED",
    baselineSealObjectDigest: OBJECT,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    verificationPlanObjectDigest: OBJECT,
    obligationResults: [
      { obligationId: OBL_PASS, status: "PASS", evidenceIds: ["ev-pass"], reason: "held" },
      { obligationId: OBL_FAIL, status: "FAIL", evidenceIds: ["ev-fail"], reason: "candidate test failed" },
    ],
    failures: [
      {
        code: "PATCH_FUNCTIONAL",
        attribution: "CANDIDATE",
        repairOwner: "CLOUD",
        certainty: "CONFIRMED",
        obligationIds: [OBL_FAIL],
        evidenceIds: ["ev-fail"],
        failureSignature: failSig,
        summary: "candidate test failed",
      },
    ],
    evidenceRootDigest,
    evidenceAssessments: [],
    workflowState: "REPAIRABLE",
    ...overrides,
  };
}

export function failObligation(id: ProofObligation["id"] = OBL_FAIL, path = "src/fail.ts"): ProofObligation {
  return obligation({
    id,
    requirementIds: [REQ],
    claim: "failing behavior holds",
    sourceRefs: [repoRef(path)],
  });
}

export function failEvidence(
  origin: EvidenceRecord["origin"] = "VERIFIER",
  id = "ev-fail",
  obligationId: ProofObligation["id"] = OBL_FAIL,
): EvidenceRecord {
  return evidence({
    id,
    obligationId,
    relation: "REFUTES",
    origin,
  });
}

export function admissibleAssessment(
  evidenceId = "ev-fail",
): VerdictReport["evidenceAssessments"][number] {
  return {
    evidenceId,
    state: "ADMISSIBLE",
    policyRevisionObjectDigest: OBJECT,
  };
}

export function inadmissibleAssessment(
  evidenceId: string,
  origin: "LOCAL_MODEL" | "CLOUD_CLAIM",
): VerdictReport["evidenceAssessments"][number] {
  return {
    evidenceId,
    state: "INADMISSIBLE",
    policyRevisionObjectDigest: OBJECT,
    reasons: [`origin:${origin}`],
  };
}

export function passObligation(): ProofObligation {
  return obligation({
    id: OBL_PASS,
    requirementIds: [REQ],
    claim: "passing behavior holds",
    sourceRefs: [repoRef("src/pass.ts")],
  });
}

export function utf8Artifact(text: string, sourceRefs: readonly SourceRef[] = [repoRef("src/fail.ts")]) {
  return {
    objectDigest: OBJECT,
    mediaType: "text/plain; charset=utf-8",
    sourceRefs: [...sourceRefs],
    content: { encoding: "utf-8" as const, text },
  };
}

export { CHECK, DIGEST, OBJECT, OBL, REQ, RUN, SNAP, obligation };
