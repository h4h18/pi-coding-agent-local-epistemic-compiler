import { Compile } from "typebox/compile";
import {
  RepairPacketSchema,
  objectDigestFromBytes,
  type CheckNode,
  type Digest,
  type EvidenceRecord,
  type ObjectDigest,
  type ObligationId,
  type ProofObligation,
  type RepairPacket,
  type RunId,
  type SnapshotId,
  type SourceRef,
  type VerificationPlan,
  type VerdictReport,
} from "@pi-hec/contracts";
import { topologicalChecks } from "./plan/dag.js";
import { ADMISSIBILITY_POLICY } from "./evidence/policy.js";

const PACKET = Compile(RepairPacketSchema);

export type CheckOutcome = "PASS" | "FAIL" | "UNKNOWN";

export type InlineFailureContent =
  | { encoding: "utf-8"; text: string }
  | { encoding: "base64"; base64: string }
  | { encoding: "digest-only" };

export type FailureArtifactInput = {
  objectDigest: ObjectDigest;
  mediaType: string;
  sourceRefs: readonly SourceRef[];
  content: InlineFailureContent;
  evidenceIds?: readonly string[];
  obligationIds?: readonly ObligationId[];
};

export type BuildRepairPacketInput = {
  runId: RunId;
  baseSnapshotId: SnapshotId;
  priorCandidateId: RepairPacket["priorCandidateId"];
  priorCandidateManifestObjectDigest: ObjectDigest;
  plan: VerificationPlan;
  report: VerdictReport;
  checkResults: ReadonlyMap<string, CheckOutcome>;
  failureArtifacts: readonly FailureArtifactInput[];
  localFindingStatements?: readonly string[];
  evidence?: readonly EvidenceRecord[];
};

export type RepairPacketResult =
  | { ok: true; packet: RepairPacket }
  | {
      ok: false;
      code:
        | "INCOMPLETE_INDEPENDENT_CHECKS"
        | "DIGEST_ONLY_FAILURE_ARTIFACT"
        | "PACKET_SCHEMA"
        | "LOCAL_SEMANTIC_TEXT";
    };

function compareUtf8(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function dependentBlocked(check: CheckNode, results: ReadonlyMap<string, CheckOutcome>): boolean {
  return check.dependencies.some((id) => {
    const outcome = results.get(id);
    return outcome === undefined || outcome === "FAIL";
  });
}

export function missingIndependentCheckIds(
  plan: Pick<VerificationPlan, "checks">,
  results: ReadonlyMap<string, CheckOutcome>,
): string[] {
  const missing: string[] = [];
  for (const check of topologicalChecks(plan.checks)) {
    if (dependentBlocked(check, results)) {
      continue;
    }
    if (!results.has(check.id)) {
      missing.push(check.id);
    }
  }
  return missing;
}

function bytesOf(content: Exclude<InlineFailureContent, { encoding: "digest-only" }>): Uint8Array {
  if (content.encoding === "utf-8") {
    return Buffer.from(content.text, "utf8");
  }
  return Buffer.from(content.base64, "base64");
}

function materializeArtifact(
  artifact: FailureArtifactInput,
): RepairPacket["inlineFailureArtifacts"][number] | undefined {
  if (artifact.content.encoding === "digest-only") {
    return undefined;
  }
  if (artifact.content.encoding === "utf-8" && artifact.content.text.length === 0) {
    return undefined;
  }
  if (artifact.content.encoding === "base64" && artifact.content.base64.length === 0) {
    return undefined;
  }
  const bytes = bytesOf(artifact.content);
  return {
    objectDigest: objectDigestFromBytes(bytes),
    mediaType: artifact.mediaType,
    sourceRefs: [...artifact.sourceRefs],
    content:
      artifact.content.encoding === "utf-8"
        ? { encoding: "utf-8", text: artifact.content.text }
        : { encoding: "base64", base64: artifact.content.base64 },
  };
}

function refsOverlap(left: readonly SourceRef[], right: readonly SourceRef[]): boolean {
  const keys = new Set(left.map((ref) => JSON.stringify(ref)));
  return right.some((ref) => keys.has(JSON.stringify(ref)));
}

function artifactMatchesFailure(
  artifact: FailureArtifactInput,
  failure: VerdictReport["failures"][number],
  obligations: ReadonlyMap<string, ProofObligation>,
): boolean {
  const obligationRefs = failure.obligationIds.flatMap(
    (id) => obligations.get(id)?.sourceRefs ?? [],
  );
  if (refsOverlap(artifact.sourceRefs, obligationRefs)) {
    return true;
  }
  const boundEvidence = artifact.evidenceIds ?? [];
  if (boundEvidence.some((id) => failure.evidenceIds.includes(id))) {
    return true;
  }
  const boundObligations = artifact.obligationIds ?? [];
  return boundObligations.some((id) => failure.obligationIds.includes(id));
}

function clusterFailures(
  failures: readonly VerdictReport["failures"][number][],
): VerdictReport["failures"][number][][] {
  const parent = failures.map((_, index) => index);
  const find = (index: number): number => {
    const current = parent[index];
    if (current === undefined || current === index) {
      return index;
    }
    const root = find(current);
    parent[index] = root;
    return root;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) {
      parent[b] = a;
    }
  };
  for (let i = 0; i < failures.length; i += 1) {
    const left = failures[i];
    if (left === undefined) {
      continue;
    }
    const leftIds = new Set(left.obligationIds);
    for (let j = i + 1; j < failures.length; j += 1) {
      const right = failures[j];
      if (right === undefined) {
        continue;
      }
      if (right.obligationIds.some((id) => leftIds.has(id))) {
        union(i, j);
      }
    }
  }
  const groups = new Map<number, VerdictReport["failures"][number][]>();
  for (let i = 0; i < failures.length; i += 1) {
    const failure = failures[i];
    if (failure === undefined) {
      continue;
    }
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(failure);
    groups.set(root, list);
  }
  return [...groups.values()];
}

function containsNeedle(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(needle);
}

const FORBIDDEN_EVIDENCE_ORIGINS: ReadonlySet<string> = new Set(
  ADMISSIBILITY_POLICY.forbiddenOrigins,
);

export function isRepairEligible(input: {
  report: VerdictReport;
  evidence?: readonly EvidenceRecord[];
  plan?: Pick<VerificationPlan, "obligations">;
}): boolean {
  const { report } = input;
  if (report.verdict !== "REJECTED" && report.verdict !== "INCONCLUSIVE") {
    return false;
  }
  if (report.evidenceAssessments.length === 0) {
    return false;
  }
  const cloudConfirmed = report.failures.filter(
    (failure) => failure.repairOwner === "CLOUD" && failure.certainty === "CONFIRMED",
  );
  if (cloudConfirmed.length === 0) {
    return false;
  }
  const admissibleIds = new Set(
    report.evidenceAssessments
      .filter((item) => item.state === "ADMISSIBLE")
      .map((item) => item.evidenceId),
  );
  const records = new Map((input.evidence ?? []).map((item) => [item.id, item] as const));
  const independentlyReproduced = cloudConfirmed.some((failure) =>
    failure.evidenceIds.some((id) => {
      if (!admissibleIds.has(id)) {
        return false;
      }
      const record = records.get(id);
      if (record === undefined) {
        return false;
      }
      return !FORBIDDEN_EVIDENCE_ORIGINS.has(record.origin);
    }),
  );
  if (!independentlyReproduced) {
    return false;
  }
  return !hasBlockingUnknown(report, input.plan);
}

function hasBlockingUnknown(
  report: VerdictReport,
  plan: Pick<VerificationPlan, "obligations"> | undefined,
): boolean {
  const mandatory = new Map(
    (plan?.obligations ?? []).map((item) => [item.id, item.mandatory] as const),
  );
  for (const result of report.obligationResults) {
    if (result.status !== "UNKNOWN") {
      continue;
    }
    if (mandatory.get(result.obligationId) === false) {
      continue;
    }
    return true;
  }
  return false;
}

export function buildRepairPacket(input: BuildRepairPacketInput): RepairPacketResult {
  if (missingIndependentCheckIds(input.plan, input.checkResults).length > 0) {
    return { ok: false, code: "INCOMPLETE_INDEPENDENT_CHECKS" };
  }
  const obligations = new Map(input.plan.obligations.map((item) => [item.id, item] as const));
  const inline: RepairPacket["inlineFailureArtifacts"] = [];
  for (const failure of input.report.failures) {
    const matches = input.failureArtifacts.filter((artifact) =>
      artifactMatchesFailure(artifact, failure, obligations),
    );
    const materialized = matches.map(materializeArtifact);
    if (
      matches.some((artifact) => artifact.content.encoding === "digest-only") ||
      materialized.some((item) => item === undefined)
    ) {
      return { ok: false, code: "DIGEST_ONLY_FAILURE_ARTIFACT" };
    }
    const present = materialized.filter(
      (item): item is NonNullable<typeof item> => item !== undefined,
    );
    if (present.length === 0) {
      return { ok: false, code: "DIGEST_ONLY_FAILURE_ARTIFACT" };
    }
    inline.push(...present);
  }
  const passing = uniqueSorted(
    input.report.obligationResults
      .filter((item) => item.status === "PASS")
      .map((item) => item.obligationId),
  ) as ObligationId[];
  const unresolved = uniqueSorted(
    input.report.obligationResults
      .filter((item) => item.status === "FAIL" || item.status === "UNKNOWN")
      .map((item) => item.obligationId),
  ) as ObligationId[];
  const clusters = clusterFailures(input.report.failures).map((group) => {
    const sorted = [...group].sort((left, right) =>
      compareUtf8(left.failureSignature, right.failureSignature),
    );
    const primary = sorted[0];
    if (primary === undefined) {
      throw new Error("empty failure cluster");
    }
    const refs = uniqueSorted(
      group.flatMap((failure) =>
        failure.obligationIds
          .flatMap((id) => obligations.get(id)?.sourceRefs ?? [])
          .map((ref) => JSON.stringify(ref)),
      ),
    ).map((raw) => JSON.parse(raw) as SourceRef);
    return {
      primaryFailureSignature: primary.failureSignature,
      secondaryFailureSignatures: sorted.slice(1).map((item) => item.failureSignature) as Digest[],
      baselineEvidenceIds: uniqueSorted(group.flatMap((item) => item.evidenceIds)),
      relevantSourceRefs: refs,
    };
  });
  const packet: RepairPacket = {
    schemaVersion: 1,
    runId: input.runId,
    baseSnapshotId: input.baseSnapshotId,
    baselineSealObjectDigest: input.report.baselineSealObjectDigest,
    priorCandidateId: input.priorCandidateId,
    priorCandidateManifestObjectDigest: input.priorCandidateManifestObjectDigest,
    unresolvedObligationIds: unresolved,
    failureClusters: clusters,
    preservedPassingObligationIds: passing,
    prohibitedRegressionObligationIds: passing,
    inlineFailureArtifacts: dedupeArtifacts(inline),
    fullEvidenceRootDigest: input.report.evidenceRootDigest,
    requiredResponse: "FULL_REPLACEMENT_CHANGESET",
  };
  if (!PACKET.Check(packet)) {
    return { ok: false, code: "PACKET_SCHEMA" };
  }
  for (const statement of input.localFindingStatements ?? []) {
    if (statement.length > 0 && containsNeedle(packet, statement)) {
      return { ok: false, code: "LOCAL_SEMANTIC_TEXT" };
    }
  }
  return { ok: true, packet };
}

function dedupeArtifacts(
  artifacts: readonly RepairPacket["inlineFailureArtifacts"][number][],
): RepairPacket["inlineFailureArtifacts"] {
  const seen = new Set<string>();
  const out: RepairPacket["inlineFailureArtifacts"][number][] = [];
  for (const artifact of artifacts) {
    if (seen.has(artifact.objectDigest)) {
      continue;
    }
    seen.add(artifact.objectDigest);
    out.push(artifact);
  }
  return out;
}
