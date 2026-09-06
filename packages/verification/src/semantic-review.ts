import {
  RetrievalActionSchema,
  RetrievalIntentSchema,
  type EvidenceId,
  type EvidenceRelation,
  type LocalSemanticFinding,
  type ProofObligation,
  type RetrievalAction,
  type RetrievalIntent,
  type RunId,
  type SemanticVerificationResult,
  type SnapshotId,
  type SourceRef,
} from "@pi-hec/contracts";
import { Compile } from "typebox/compile";
import { mintGeneralId, mintObligationId } from "./plan/ids.js";

const INTENT = Compile(RetrievalIntentSchema);
const ACTION = Compile(RetrievalActionSchema);

export type SemanticReviewSchedule = {
  intents: readonly RetrievalIntent[];
  actions: readonly RetrievalAction[];
  obligations: readonly ProofObligation[];
};

export type ScheduleEvidenceInput = {
  runId: RunId;
  snapshotId: SnapshotId;
  findings: readonly LocalSemanticFinding[];
  authoritativeClaimIds?: readonly EvidenceId[];
};

function sourceIdentity(ref: SourceRef): string {
  switch (ref.origin) {
    case "repository":
      return `repository:${ref.sourceKind}:${ref.path}`;
    case "artifact":
      return `artifact:${ref.sourceKind}:${ref.artifactObjectDigest}`;
    case "external":
      return `external:${ref.url}`;
    default: {
      const exhaustive: never = ref;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function entityHint(ref: SourceRef): string | undefined {
  switch (ref.origin) {
    case "repository":
      return ref.path;
    case "artifact":
      return ref.artifactObjectDigest;
    case "external":
      return ref.url;
    default: {
      const exhaustive: never = ref;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function channelForFinding(
  kind: LocalSemanticFinding["kind"],
): "lexical" | "structural" | "history" | "tests" | "instructions" {
  switch (kind) {
    case "AMBIGUITY":
      return "instructions";
    case "CONTRADICTION":
      return "tests";
    case "RISK":
      return "tests";
    case "ROOT_CAUSE_HYPOTHESIS":
      return "structural";
    case "SEMANTIC_MISMATCH":
      return "structural";
    case "MISSING_EVIDENCE":
      return "lexical";
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function relationForFinding(kind: LocalSemanticFinding["kind"]): EvidenceRelation {
  switch (kind) {
    case "AMBIGUITY":
      return "REFERENCES";
    case "CONTRADICTION":
      return "CONTRADICTS";
    case "RISK":
      return "AFFECTS";
    case "ROOT_CAUSE_HYPOTHESIS":
      return "BLAMES";
    case "SEMANTIC_MISMATCH":
      return "CONTRADICTS";
    case "MISSING_EVIDENCE":
      return "REFERENCES";
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function queryFromRefs(refs: readonly SourceRef[]): string | undefined {
  for (const ref of refs) {
    const hint = entityHint(ref);
    if (hint !== undefined && hint.length > 0) {
      return hint.slice(0, 4096);
    }
  }
  return undefined;
}

function pathFilters(refs: readonly SourceRef[]): RetrievalAction["filters"] {
  const paths = refs
    .filter(
      (ref): ref is Extract<SourceRef, { origin: "repository" }> => ref.origin === "repository",
    )
    .map((ref) => ref.path);
  if (paths.length === 0) {
    return {};
  }
  return { pathPrefix: paths.length === 1 ? (paths[0] ?? "") : paths };
}

export function scheduleEvidenceFromFindings(input: ScheduleEvidenceInput): SemanticReviewSchedule {
  const claimIds = [...(input.authoritativeClaimIds ?? [])];
  const intents: RetrievalIntent[] = [];
  const actions: RetrievalAction[] = [];
  const obligations: ProofObligation[] = [];
  const seenObligation = new Set<string>();
  for (const finding of input.findings) {
    const hints = finding.sourceRefs
      .map(entityHint)
      .filter((hint): hint is string => hint !== undefined && hint.length > 0);
    const intent: RetrievalIntent = {
      runId: input.runId,
      snapshotId: input.snapshotId,
      claimIds,
      entityHints: hints,
      relationHints: [relationForFinding(finding.kind)],
    };
    if (!INTENT.Check(intent)) {
      throw new Error("RetrievalIntent failed schema validation");
    }
    intents.push(intent);
    const query = queryFromRefs(finding.sourceRefs);
    if (query !== undefined) {
      const action: RetrievalAction = {
        id: mintGeneralId("act", `${finding.id}:${channelForFinding(finding.kind)}`),
        channelId: channelForFinding(finding.kind),
        targetClaimIds: claimIds,
        query,
        filters: pathFilters(finding.sourceRefs),
        expectedInformationGain: 0.5,
        expectedTrustGain: 0.5,
        estimatedLatencyMs: 1,
        estimatedPacketTokens: 1,
      };
      if (!ACTION.Check(action)) {
        throw new Error("RetrievalAction failed schema validation");
      }
      actions.push(action);
    }
    if (finding.sourceRefs.length === 0) {
      continue;
    }
    const claim = finding.sourceRefs.map(sourceIdentity).join("|").slice(0, 16384);
    const id = mintObligationId({
      requirementIds: finding.requirementIds,
      claim,
      kind: "EVIDENCE_INTEGRITY",
    });
    if (seenObligation.has(id)) {
      continue;
    }
    seenObligation.add(id);
    obligations.push({
      id,
      requirementIds: [...finding.requirementIds],
      claim,
      claimMode: "EXISTENTIAL",
      kind: "EVIDENCE_INTEGRITY",
      mandatory: true,
      sourceRefs: [...finding.sourceRefs],
      prerequisites: [],
    });
  }
  return { intents, actions, obligations };
}

export function openEvidenceObligationsFromReview(
  input: Omit<ScheduleEvidenceInput, "findings"> & { review: SemanticVerificationResult },
): SemanticReviewSchedule {
  const { review, ...schedule } = input;
  return scheduleEvidenceFromFindings({ ...schedule, findings: review.findings });
}
