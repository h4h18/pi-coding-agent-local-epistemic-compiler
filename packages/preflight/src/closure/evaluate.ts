import { Compile } from "typebox/compile";
import {
  ClosureReportSchema,
  canonicalizeRfc8785,
  objectDigestFromBytes,
  payloadDigest,
  type ClosureReport,
  type Digest,
  type EvidenceGraph,
  type EvidenceId,
  type JsonValue,
  type ObjectDigest,
  type RequirementId,
  type RunId,
  type SnapshotId,
} from "@pi-hec/contracts";
import { compareUtf8 } from "@pi-hec/evidence";
import {
  allTemplatePredicatesPass,
  criticalConflicts,
  dependencyNodes,
  factUnknowns,
  instructionNodes,
  locusNodeIds,
  reverseDependencyEdges,
  type ClosureTemplate,
} from "./templates.js";

const REPORT = Compile(ClosureReportSchema);

export const CLOSURE_STATES = ["COMPLETE", "SATURATED_WITH_UNKNOWNS", "RESOURCE_LIMITED"] as const;
export type ClosureState = (typeof CLOSURE_STATES)[number];

export type PreflightRequirement = {
  id: RequirementId;
  priority: "MUST" | "SHOULD";
  text: string;
};

export type WitnessRecord = {
  requirementId: RequirementId;
  bundleIds: string[];
  status: "covered" | "unknown" | "conflicted";
};

export type ClosureEvaluation = {
  state: ClosureState;
  templatePredicatesPass: boolean;
  witnesses: WitnessRecord[];
  unresolvedCriticalEvidenceIds: EvidenceId[];
  frontierFixed: boolean;
  channelsDrained: boolean;
  auditStable: boolean;
};

export type ResourceLimitSignal = {
  aborted: boolean;
  runnerAvailable: boolean;
  memoryBytes?: number;
  modelContextTokens?: number;
  timeoutMs?: number;
};

const MEMORY_FLOOR_BYTES = 1;
const CONTEXT_FLOOR_TOKENS = 1;

export function resourceLimitHit(limits: ResourceLimitSignal): boolean {
  if (limits.aborted) {
    return true;
  }
  if (!limits.runnerAvailable) {
    return true;
  }
  if (limits.timeoutMs !== undefined && limits.timeoutMs <= 0) {
    return true;
  }
  if (limits.memoryBytes !== undefined && limits.memoryBytes < MEMORY_FLOOR_BYTES) {
    return true;
  }
  if (limits.modelContextTokens !== undefined && limits.modelContextTokens < CONTEXT_FLOOR_TOKENS) {
    return true;
  }
  return false;
}

export function requirementHasWitness(graph: EvidenceGraph, requirementId: RequirementId): boolean {
  const requirement = graph.nodes.find(
    (node) => node.identityKey === `requirement:${requirementId}`,
  );
  if (requirement === undefined) {
    return false;
  }
  return graph.edges.some(
    (edge) =>
      (edge.from === requirement.id || edge.to === requirement.id) &&
      (edge.relation === "SATISFIES" ||
        edge.relation === "COVERED_BY" ||
        edge.relation === "SUPPORTS"),
  );
}

export function evaluateWitnesses(
  graph: EvidenceGraph,
  requirements: readonly PreflightRequirement[],
): WitnessRecord[] {
  return [...requirements]
    .sort((left, right) => compareUtf8(left.id, right.id))
    .map((requirement) => {
      const conflicted = criticalConflicts(graph).some((node) =>
        graph.edges.some(
          (edge) =>
            (edge.from === node.id || edge.to === node.id) &&
            graph.nodes.some(
              (req) =>
                req.identityKey === `requirement:${requirement.id}` &&
                (edge.from === req.id || edge.to === req.id),
            ),
        ),
      );
      if (conflicted) {
        return { requirementId: requirement.id, bundleIds: [], status: "conflicted" as const };
      }
      if (requirementHasWitness(graph, requirement.id)) {
        return {
          requirementId: requirement.id,
          bundleIds: [`bundle_witness_${requirement.id}`],
          status: "covered" as const,
        };
      }
      return { requirementId: requirement.id, bundleIds: [], status: "unknown" as const };
    });
}

export function mandatoryClosurePredicatesPass(
  template: ClosureTemplate,
  graph: EvidenceGraph,
  requirements: readonly PreflightRequirement[],
): boolean {
  if (!allTemplatePredicatesPass(template, graph)) {
    return false;
  }
  const musts = requirements.filter((item) => item.priority === "MUST");
  if (musts.some((item) => !requirementHasWitness(graph, item.id))) {
    return false;
  }
  if (locusNodeIds(graph).length === 0) {
    return false;
  }
  if (reverseDependencyEdges(graph) === 0) {
    return false;
  }
  if (instructionNodes(graph).length === 0) {
    return false;
  }
  const dependencies = dependencyNodes(graph);
  if (dependencies.length === 0 || dependencies.some((node) => node.status !== "verified")) {
    return false;
  }
  if (factUnknowns(graph).length > 0) {
    return false;
  }
  if (criticalConflicts(graph).length > 0) {
    return false;
  }
  return true;
}

export function evaluateClosureState(input: {
  template: ClosureTemplate;
  graph: EvidenceGraph;
  requirements: readonly PreflightRequirement[];
  frontierFixed: boolean;
  channelsDrained: boolean;
  auditStable: boolean;
  resources: ResourceLimitSignal;
  unresolvedCriticalEvidenceIds: readonly EvidenceId[];
}): ClosureEvaluation {
  const witnesses = evaluateWitnesses(input.graph, input.requirements);
  const templatePass = mandatoryClosurePredicatesPass(
    input.template,
    input.graph,
    input.requirements,
  );
  if (resourceLimitHit(input.resources)) {
    return {
      state: "RESOURCE_LIMITED",
      templatePredicatesPass: templatePass,
      witnesses,
      unresolvedCriticalEvidenceIds: [...input.unresolvedCriticalEvidenceIds],
      frontierFixed: input.frontierFixed,
      channelsDrained: input.channelsDrained,
      auditStable: input.auditStable,
    };
  }
  if (templatePass && input.frontierFixed && input.channelsDrained && input.auditStable) {
    return {
      state: "COMPLETE",
      templatePredicatesPass: true,
      witnesses,
      unresolvedCriticalEvidenceIds: [],
      frontierFixed: true,
      channelsDrained: true,
      auditStable: true,
    };
  }
  return {
    state: "SATURATED_WITH_UNKNOWNS",
    templatePredicatesPass: templatePass,
    witnesses,
    unresolvedCriticalEvidenceIds: [...input.unresolvedCriticalEvidenceIds],
    frontierFixed: input.frontierFixed,
    channelsDrained: input.channelsDrained,
    auditStable: input.auditStable,
  };
}

export function buildClosureReport(input: {
  runId: RunId;
  snapshotId: SnapshotId;
  evaluation: ClosureEvaluation;
  evidenceGraphObjectDigest: ObjectDigest;
  exhaustedActionDigests: readonly ClosureReport["exhaustedActionDigests"][number][];
  stabilityAuditObjectDigest: ObjectDigest;
}): ClosureReport {
  const report: ClosureReport = {
    schemaVersion: 1,
    runId: input.runId,
    snapshotId: input.snapshotId,
    state: input.evaluation.state,
    evidenceGraphObjectDigest: input.evidenceGraphObjectDigest,
    requirementWitnesses: input.evaluation.witnesses,
    unresolvedCriticalEvidenceIds: input.evaluation.unresolvedCriticalEvidenceIds,
    exhaustedActionDigests: [...input.exhaustedActionDigests],
    stabilityAuditObjectDigest: input.stabilityAuditObjectDigest,
  };
  if (!REPORT.Check(report)) {
    throw new Error("closure report failed schema validation");
  }
  return report;
}

export function closureReportDigest(report: ClosureReport): Digest {
  return payloadDigest({
    schemaName: "ClosureReport",
    schemaVersion: 1,
    payload: JSON.parse(canonicalizeRfc8785(report)) as JsonValue,
  });
}

export function digestCanonical(value: unknown): ObjectDigest {
  return objectDigestFromBytes(Buffer.from(canonicalizeRfc8785(value), "utf8"));
}
