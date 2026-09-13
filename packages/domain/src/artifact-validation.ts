import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import {
  AcceptanceLedgerSchema,
  ChangeManifestSchema,
  ChangeShardsSchema,
  ImplementationPlanSchema,
  InvestigationReportSchema,
  ReproductionUnavailableSchema,
  ReviewFindingsSchema,
  SpecUpdateNotRequiredSchema,
  TaskContractSchema,
  type AgentRole,
  type ArtifactType,
  type TaskContract,
  type WorkerArtifactEnvelope,
} from "@pi-hec/contracts";

export const ROLE_ARTIFACT_TYPES: Readonly<Record<AgentRole, readonly ArtifactType[]>> = {
  analyst: ["task-contract"],
  investigator: ["investigation-report", "reproduction-unavailable"],
  planner: ["implementation-plan", "change-shards"],
  implementer: ["change-manifest", "changeset"],
  reviewer: ["review-findings"],
  "spec-reviewer": ["review-findings"],
  "security-reviewer": ["review-findings"],
  "architecture-reviewer": ["review-findings"],
  "test-reviewer": ["review-findings"],
  "performance-reviewer": ["review-findings"],
  "conflict-resolver": ["investigation-report"],
  "final-synthesizer": ["investigation-report"],
};

const SCHEMA_BY_TYPE: Readonly<Partial<Record<ArtifactType, TSchema>>> = {
  "task-contract": TaskContractSchema,
  "investigation-report": InvestigationReportSchema,
  "implementation-plan": ImplementationPlanSchema,
  "change-shards": ChangeShardsSchema,
  "change-manifest": ChangeManifestSchema,
  "review-findings": ReviewFindingsSchema,
  "acceptance-ledger": AcceptanceLedgerSchema,
  "reproduction-unavailable": ReproductionUnavailableSchema,
  "spec-update-not-required": SpecUpdateNotRequiredSchema,
};

export type ArtifactValidationIssue = {
  path: string;
  message: string;
};

export type ArtifactValidationResult =
  | { ok: true }
  | { ok: false; issues: readonly ArtifactValidationIssue[] };

function schemaFor(type: ArtifactType): TSchema | undefined {
  return SCHEMA_BY_TYPE[type];
}

function logicalConflicts(contract: TaskContract): ArtifactValidationIssue[] {
  const issues: ArtifactValidationIssue[] = [];
  const ids = new Set<string>();
  for (const criterion of contract.acceptanceCriteria) {
    if (ids.has(criterion.id)) {
      issues.push({ path: "acceptanceCriteria", message: `duplicate criterion ${criterion.id}` });
    }
    ids.add(criterion.id);
  }
  if (contract.inScope.some((item) => contract.outOfScope.includes(item))) {
    issues.push({ path: "inScope", message: "inScope overlaps outOfScope" });
  }
  if (contract.kind === "research" && contract.specPolicy.updateRequired) {
    issues.push({ path: "specPolicy", message: "research contract cannot require spec update" });
  }
  if (contract.kind === "spec" && !contract.specPolicy.updateRequired) {
    issues.push({ path: "specPolicy", message: "spec contract must require spec update" });
  }
  return issues;
}

export function roleMayProduce(role: AgentRole, artifactType: ArtifactType): boolean {
  return ROLE_ARTIFACT_TYPES[role].includes(artifactType);
}

export function validateWorkerEnvelope(
  envelope: WorkerArtifactEnvelope,
  expected: { runId: string; nodeId: string; agentId: string; artifactType: ArtifactType },
): ArtifactValidationResult {
  const issues: ArtifactValidationIssue[] = [];
  if (envelope.runId !== expected.runId) {
    issues.push({ path: "runId", message: "runId mismatch" });
  }
  if (envelope.nodeId !== expected.nodeId) {
    issues.push({ path: "nodeId", message: "nodeId mismatch" });
  }
  if (envelope.agentId !== expected.agentId) {
    issues.push({ path: "agentId", message: "agentId mismatch" });
  }
  if (envelope.artifactType !== expected.artifactType) {
    issues.push({ path: "artifactType", message: "artifactType mismatch" });
  }
  const schema = schemaFor(envelope.artifactType);
  if (schema === undefined) {
    if (envelope.artifactType === "changeset" || envelope.artifactType === "verdict-report") {
      return issues.length === 0 ? { ok: true } : { ok: false, issues };
    }
    issues.push({ path: "artifactType", message: "unsupported artifact type" });
    return { ok: false, issues };
  }
  const compiled = Compile(schema);
  if (!compiled.Check(envelope.payload)) {
    const details = compiled.Errors(envelope.payload).slice(0, 8);
    if (details.length === 0) {
      issues.push({ path: "payload", message: "payload failed JSON Schema" });
    } else {
      for (const error of details) {
        issues.push({
          path: `payload${error.instancePath}`,
          message: error.message,
        });
      }
    }
  } else if (envelope.artifactType === "task-contract") {
    issues.push(...logicalConflicts(envelope.payload as TaskContract));
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function implementerMayNotAccept(role: AgentRole, artifactType: ArtifactType): boolean {
  return role === "implementer" && artifactType === "review-findings";
}
