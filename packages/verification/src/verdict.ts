import {
  canonicalize,
  objectDigestFromBytes,
  taggedHash,
  type EvidenceRecord,
  type ObligationStatus,
  type ProofObligation,
  type VerificationPlan,
  type Verdict,
  type VerdictReport,
} from "@pi-hec/contracts";
import { topologicalObligations } from "./plan/dag.js";
import { toJsonValue } from "@pi-hec/contracts";
import { classifyFlake, pairedFlake } from "./evidence/flake.js";
import type { EvidenceAssessment } from "./evidence/assess.js";
import { admissibleRecords } from "./evidence/assess.js";

export type ObligationEvaluation = {
  obligationId: ProofObligation["id"];
  mandatory: boolean;
  status: ObligationStatus;
  evidenceIds: readonly string[];
  reason: string;
  failAttribution?: VerdictReport["failures"][number]["attribution"];
  failCertainty?: VerdictReport["failures"][number]["certainty"];
  failCode?: string;
};

export type DecideVerdictInput = {
  obligations: readonly ObligationEvaluation[];
  integrityViolation: boolean;
  sealsValid: boolean;
  unresolvedBlockers: boolean;
};

export function decideVerdict(input: DecideVerdictInput): Verdict {
  if (input.integrityViolation) {
    return "REJECTED";
  }
  const mandatory = input.obligations.filter((item) => item.mandatory);
  const confirmedFail = mandatory.some(
    (item) =>
      item.status === "FAIL" &&
      item.failCertainty === "CONFIRMED" &&
      item.failAttribution === "CANDIDATE",
  );
  if (confirmedFail) {
    return "REJECTED";
  }
  if (!input.sealsValid || input.unresolvedBlockers) {
    return "INCONCLUSIVE";
  }
  if (mandatory.length === 0) {
    return "INCONCLUSIVE";
  }
  if (mandatory.some((item) => item.status === "UNKNOWN")) {
    return "INCONCLUSIVE";
  }
  if (mandatory.some((item) => item.status === "FAIL")) {
    return "INCONCLUSIVE";
  }
  if (mandatory.every((item) => item.status === "PASS")) {
    return "ACCEPTED";
  }
  return "INCONCLUSIVE";
}

export function evaluateObligation(input: {
  obligation: ProofObligation;
  statuses: ReadonlyMap<string, ObligationStatus>;
  admissible: readonly EvidenceRecord[];
}): ObligationEvaluation {
  const related = input.admissible.filter((item) => item.obligationId === input.obligation.id);
  const evidenceIds = related.map((item) => item.id);
  for (const pre of input.obligation.prerequisites) {
    const preStatus = input.statuses.get(pre);
    if (preStatus !== "PASS") {
      const counter = classifyCounterevidence(related);
      if (
        counter !== undefined &&
        counter.certainty === "CONFIRMED" &&
        counter.attribution === "CANDIDATE"
      ) {
        return {
          obligationId: input.obligation.id,
          mandatory: input.obligation.mandatory,
          status: "FAIL",
          evidenceIds,
          reason: "prerequisite missing with candidate-attributable counterevidence",
          failAttribution: counter.attribution,
          failCertainty: counter.certainty,
          failCode: counter.code,
        };
      }
      return {
        obligationId: input.obligation.id,
        mandatory: input.obligation.mandatory,
        status: "UNKNOWN",
        evidenceIds,
        reason: `prerequisite ${pre} is not PASS`,
      };
    }
  }
  const counter = classifyCounterevidence(related);
  if (
    counter !== undefined &&
    counter.certainty === "CONFIRMED" &&
    counter.attribution === "CANDIDATE"
  ) {
    return {
      obligationId: input.obligation.id,
      mandatory: input.obligation.mandatory,
      status: "FAIL",
      evidenceIds,
      reason: "admissible stable candidate-attributable counterevidence",
      failAttribution: counter.attribution,
      failCertainty: counter.certainty,
      failCode: counter.code,
    };
  }
  if (counter !== undefined && counter.certainty === "PROBABLE") {
    return {
      obligationId: input.obligation.id,
      mandatory: input.obligation.mandatory,
      status: "UNKNOWN",
      evidenceIds,
      reason: "probable attribution cannot reject",
      failAttribution: counter.attribution,
      failCertainty: counter.certainty,
      failCode: counter.code,
    };
  }
  const supports = dischargingSupports(
    input.obligation,
    related.filter((item) => item.relation === "SUPPORTS"),
  );
  if (supports.length === 0) {
    return {
      obligationId: input.obligation.id,
      mandatory: input.obligation.mandatory,
      status: "UNKNOWN",
      evidenceIds,
      reason: "missing admissible supporting evidence",
    };
  }
  if (counter !== undefined) {
    return {
      obligationId: input.obligation.id,
      mandatory: input.obligation.mandatory,
      status: "UNKNOWN",
      evidenceIds,
      reason: "counterevidence is not confirmed candidate-attributable",
      failAttribution: counter.attribution,
      failCertainty: counter.certainty,
      failCode: counter.code,
    };
  }
  const flake = flakeStatus(related);
  if (flake === "unknown-instability") {
    return {
      obligationId: input.obligation.id,
      mandatory: input.obligation.mandatory,
      status: "UNKNOWN",
      evidenceIds,
      reason: "flake classifier did not reach a stable pass",
    };
  }
  if (flake === "stable-fail") {
    return {
      obligationId: input.obligation.id,
      mandatory: input.obligation.mandatory,
      status: "FAIL",
      evidenceIds,
      reason: "stable candidate-only failure",
      failAttribution: "CANDIDATE",
      failCertainty: "CONFIRMED",
      failCode: "PATCH_FUNCTIONAL",
    };
  }
  return {
    obligationId: input.obligation.id,
    mandatory: input.obligation.mandatory,
    status: "PASS",
    evidenceIds,
    reason: "discharge policy met by admissible evidence",
  };
}

function classifyCounterevidence(records: readonly EvidenceRecord[]):
  | {
      attribution: VerdictReport["failures"][number]["attribution"];
      certainty: VerdictReport["failures"][number]["certainty"];
      code: string;
    }
  | undefined {
  const refutes = records.filter((item) => item.relation === "REFUTES");
  if (refutes.length === 0) {
    return undefined;
  }
  const candidateRefutes = refutes.filter((item) => item.subject.kind === "CANDIDATE");
  const baselineRecords = records.filter(
    (item) => item.subject.kind === "BASELINE" && item.oracle !== "RED_GREEN",
  );
  for (const record of candidateRefutes) {
    if (record.origin === "CANDIDATE_TEST" && record.oracle !== "RED_GREEN") {
      return { attribution: "CANDIDATE", certainty: "PROBABLE", code: "PATCH_FUNCTIONAL" };
    }
    if (record.origin === "USER" && record.oracle !== "HUMAN_AUTHORIZED") {
      return { attribution: "CANDIDATE", certainty: "PROBABLE", code: "PATCH_FUNCTIONAL" };
    }
  }
  if (candidateRefutes.length === 0) {
    return { attribution: "BASELINE", certainty: "CONFIRMED", code: "BASE_PREEXISTING_FAIL" };
  }
  const candidateObs = candidateRefutes.flatMap((item) => item.observations);
  const baselineObs = baselineRecords.flatMap((item) => item.observations);
  if (baselineObs.length > 0) {
    const paired = pairedFlake({ baseline: baselineObs, candidate: candidateObs });
    if (paired === "stable-fail") {
      return { attribution: "CANDIDATE", certainty: "CONFIRMED", code: "PATCH_FUNCTIONAL" };
    }
    if (paired === "unknown-instability") {
      return { attribution: "CANDIDATE", certainty: "UNRESOLVED", code: "TEST_FLAKY" };
    }
    return { attribution: "UNKNOWN", certainty: "UNRESOLVED", code: "PATCH_FUNCTIONAL" };
  }
  const flake = classifyFlake(candidateObs);
  if (flake === "unknown-instability") {
    return { attribution: "CANDIDATE", certainty: "UNRESOLVED", code: "TEST_FLAKY" };
  }
  if (flake === "stable-fail" || candidateObs.length === 0) {
    return { attribution: "CANDIDATE", certainty: "CONFIRMED", code: "PATCH_FUNCTIONAL" };
  }
  return { attribution: "UNKNOWN", certainty: "UNRESOLVED", code: "PATCH_FUNCTIONAL" };
}

export type CompileVerdictInput = {
  plan: Pick<VerificationPlan, "obligations" | "baselineSealObjectDigest">;
  planObjectDigest: VerificationPlan["baselineSealObjectDigest"];
  evidence: readonly EvidenceRecord[];
  assessments: readonly EvidenceAssessment[];
  subject: VerdictReport["subject"];
  integrityViolation: boolean;
  sealsValid: boolean;
  unresolvedBlockers: boolean;
};

export function compileVerdictReport(input: CompileVerdictInput): VerdictReport {
  const admissible = admissibleRecords(input.evidence, input.assessments);
  const statuses = new Map<string, ObligationStatus>();
  const evaluations: ObligationEvaluation[] = [];
  for (const obligation of topologicalObligations(input.plan.obligations)) {
    const evaluation = evaluateObligation({ obligation, statuses, admissible });
    statuses.set(obligation.id, evaluation.status);
    evaluations.push(evaluation);
  }
  const verdict = decideVerdict({
    obligations: evaluations,
    integrityViolation: input.integrityViolation,
    sealsValid: input.sealsValid,
    unresolvedBlockers: input.unresolvedBlockers,
  });
  const failures = evaluations
    .filter(
      (item) =>
        item.status === "FAIL" || (item.failCertainty === "PROBABLE" && item.status === "UNKNOWN"),
    )
    .map((item) => ({
      code: item.failCode ?? "PATCH_FUNCTIONAL",
      attribution: item.failAttribution ?? "UNKNOWN",
      repairOwner: repairOwner(item.failAttribution ?? "UNKNOWN"),
      certainty: item.failCertainty ?? "UNRESOLVED",
      obligationIds: [item.obligationId],
      evidenceIds: [...item.evidenceIds],
      failureSignature: taggedHash("failure-signature", 1, {
        obligationIds: [item.obligationId],
        attribution: item.failAttribution ?? "UNKNOWN",
        normalizedMessage: item.reason,
      }),
      summary: item.reason,
    }));
  if (input.integrityViolation) {
    failures.push({
      code: "EVIDENCE_TAMPER",
      attribution: "VERIFIER",
      repairOwner: "VERIFIER",
      certainty: "CONFIRMED",
      obligationIds: [],
      evidenceIds: [],
      failureSignature: taggedHash("failure-signature", 1, {
        obligationIds: [],
        attribution: "VERIFIER",
        normalizedMessage: "integrity violation",
      }),
      summary: "integrity violation",
    });
  }
  const evidenceRootDigest = taggedHash("verification-evidence-root", 1, {
    evidenceRecordObjectDigests: input.evidence
      .map((item) => objectDigestFromBytes(Buffer.from(canonicalize(toJsonValue(item)), "utf8")))
      .sort(),
  });
  return {
    schemaVersion: 1,
    verdict,
    baselineSealObjectDigest: input.plan.baselineSealObjectDigest,
    subject: input.subject,
    verificationPlanObjectDigest: input.planObjectDigest,
    obligationResults: evaluations.map((item) => ({
      obligationId: item.obligationId,
      status: item.status,
      evidenceIds: [...item.evidenceIds],
      reason: item.reason,
    })),
    failures,
    evidenceRootDigest,
    evidenceAssessments: [...input.assessments],
    workflowState: workflowState(verdict),
  };
}

function flakeStatus(records: readonly EvidenceRecord[]): ReturnType<typeof classifyFlake> {
  const scored = records.filter(
    (item) => item.oracle !== "RED_GREEN" && item.relation !== "NEUTRAL",
  );
  const baseline = scored
    .filter((item) => item.subject.kind === "BASELINE")
    .flatMap((item) => item.observations);
  const candidate = scored
    .filter((item) => item.subject.kind === "CANDIDATE")
    .flatMap((item) => item.observations);
  if (baseline.length > 0 && candidate.length > 0) {
    return pairedFlake({ baseline, candidate });
  }
  const classes = scored.map((item) => classifyFlake(item.observations));
  if (classes.some((item) => item === "unknown-instability")) {
    return "unknown-instability";
  }
  if (classes.some((item) => item === "stable-fail")) {
    return "stable-fail";
  }
  if (classes.length > 0 && classes.every((item) => item === "stable-pass")) {
    return "stable-pass";
  }
  return "stable-pass";
}

function dischargingSupports(
  obligation: ProofObligation,
  supports: readonly EvidenceRecord[],
): EvidenceRecord[] {
  if (obligation.claimMode === "EXISTENTIAL") {
    return [...supports];
  }
  return supports.filter((item) => !isExistentialExample(item));
}

function isExistentialExample(record: EvidenceRecord): boolean {
  return record.producerId === "coverage";
}

function repairOwner(
  attribution: VerdictReport["failures"][number]["attribution"],
): VerdictReport["failures"][number]["repairOwner"] {
  switch (attribution) {
    case "CANDIDATE":
      return "CLOUD";
    case "BASELINE":
      return "USER";
    case "ENVIRONMENT":
      return "ENVIRONMENT";
    case "REQUIREMENT":
      return "USER";
    case "VERIFIER":
      return "VERIFIER";
    case "UNKNOWN":
      return "NONE";
    default: {
      const exhaustive: never = attribution;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function workflowState(verdict: Verdict): VerdictReport["workflowState"] {
  switch (verdict) {
    case "ACCEPTED":
      return "TERMINAL";
    case "REJECTED":
      return "REPAIRABLE";
    case "INCONCLUSIVE":
      return "REPAIRABLE";
    default: {
      const exhaustive: never = verdict;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}
