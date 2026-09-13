import {
  asRequirementId,
  sha256HexToCrockford32,
  sha256Utf8,
  taggedHash,
  type RequirementId,
  type RequirementLedger,
  type SourceRef,
  type TaskContract,
  type TaskEnvelope,
} from "@pi-hec/contracts";

export function requirementIdFromStatement(kind: string, statement: string): RequirementId {
  const digest = taggedHash("requirement-id", 1, {
    kind,
    sourceRanges: [],
    verbatimQuote: statement,
  });
  return asRequirementId(`req_${sha256HexToCrockford32(digest.slice("sha256:".length))}`);
}

export function projectContractToLedger(input: {
  runId: TaskEnvelope["runId"];
  originalRequest: string;
  contract: TaskContract;
  sourceRefs: readonly SourceRef[];
}): RequirementLedger {
  const refs = [...input.sourceRefs];
  return {
    schemaVersion: 1,
    runId: input.runId,
    originalRequest: input.originalRequest,
    originalRequestDigest: sha256Utf8(input.originalRequest),
    requirements: input.contract.acceptanceCriteria.map((criterion) => ({
      id: requirementIdFromStatement("authoritative", `${criterion.id}:${criterion.statement}`),
      text: criterion.statement,
      sourceRefs: refs,
      priority: "MUST" as const,
      state: "CLEAR" as const,
      kind: "authoritative" as const,
      source: "USER_EXPLICIT" as const,
      normative: true as const,
    })),
    nonGoals: input.contract.outOfScope.map((text) => ({
      id: requirementIdFromStatement("non-goal", text),
      text,
      sourceRefs: refs,
      priority: "SHOULD" as const,
      state: "CLEAR" as const,
      kind: "authoritative" as const,
      source: "USER_EXPLICIT" as const,
      normative: true as const,
    })),
    conflicts: [],
    openQuestions: input.contract.blockingQuestions.map((question, index) => ({
      id: `q-${String(index + 1)}`,
      question,
      correctnessImpact: "blocking" as const,
      sourceRefs: refs,
    })),
  };
}
