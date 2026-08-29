import type { Static } from "typebox";
import {
  BaselineSupplementSchema,
  objectDigestFromBytes,
  type CheckNode,
  type CommandSpec,
  type ObjectDigest,
  type ProofObligation,
  type Requirement,
  type VerificationPlan,
} from "@pi-hec/contracts";
import { assertAcyclicPlan } from "./dag.js";
import { PlanError } from "./errors.js";
import { toJsonValue } from "./envelope.js";
import { mintGeneralId } from "./ids.js";
import { authorityRank } from "./command-authority.js";

type BaselineSupplement = Static<typeof BaselineSupplementSchema>;

export type PlanRevisionDelta = {
  requirements?: readonly Requirement[];
  obligations?: readonly ProofObligation[];
  checks?: readonly CheckNode[];
};

export type RevisePlanInput = {
  previous: VerificationPlan;
  previousPlanObjectDigest: ObjectDigest;
  delta: PlanRevisionDelta;
  baselineReproducible: boolean;
  now: string;
  environmentSealObjectDigest: ObjectDigest;
};

export type RevisePlanResult = {
  plan: VerificationPlan;
  supplements: readonly BaselineSupplement[];
};

export function revisePlan(input: RevisePlanInput): RevisePlanResult {
  const requirements = mergeRequirements(input.previous.requirements, input.delta.requirements ?? []);
  const obligations = mergeObligations(input.previous.obligations, input.delta.obligations ?? []);
  const checks = mergeChecks(input.previous.checks, input.delta.checks ?? [], input.baselineReproducible);
  const supplements = supplementsForLateChecks(
    input.previous,
    checks,
    input.now,
    input.environmentSealObjectDigest,
  );
  const plan: VerificationPlan = {
    schemaVersion: 1,
    planId: mintGeneralId("plan", `${input.previous.planId}:${String(input.previous.revision + 1)}`),
    revision: input.previous.revision + 1,
    baselineSealObjectDigest: input.previous.baselineSealObjectDigest,
    requirements,
    obligations,
    checks,
    baselineSupplementObjectDigests: [
      ...input.previous.baselineSupplementObjectDigests,
      ...supplements.map((item) => objectDigestFromBytes(Buffer.from(JSON.stringify(toJsonValue(item)), "utf8"))),
    ],
    previousPlanObjectDigest: input.previousPlanObjectDigest,
  };
  assertAcyclicPlan(plan);
  assertMonotonic(input.previous, plan);
  return { plan, supplements };
}

export function assertMonotonic(previous: VerificationPlan, next: VerificationPlan): void {
  for (const obligation of previous.obligations) {
    if (!next.obligations.some((item) => item.id === obligation.id)) {
      throw new PlanError("NON_MONOTONIC_REMOVE", `obligation ${obligation.id} cannot be removed`);
    }
  }
  for (const check of previous.checks) {
    if (!next.checks.some((item) => item.id === check.id)) {
      throw new PlanError("NON_MONOTONIC_REMOVE", `check ${check.id} cannot be removed`);
    }
  }
}

function mergeRequirements(
  previous: readonly Requirement[],
  added: readonly Requirement[],
): Requirement[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  for (const requirement of added) {
    const existing = byId.get(requirement.id);
    if (existing === undefined) {
      byId.set(requirement.id, requirement);
      continue;
    }
    if (!sameRequirement(existing, requirement)) {
      throw new PlanError("REINTERPRET_REQUIREMENT", `requirement ${requirement.id} cannot be reinterpreted`);
    }
  }
  return [...byId.values()];
}

function sameRequirement(left: Requirement, right: Requirement): boolean {
  return (
    left.text === right.text &&
    left.kind === right.kind &&
    left.source === right.source &&
    left.priority === right.priority &&
    left.state === right.state &&
    left.normative === right.normative
  );
}

function mergeObligations(
  previous: readonly ProofObligation[],
  added: readonly ProofObligation[],
): ProofObligation[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  for (const obligation of added) {
    const existing = byId.get(obligation.id);
    if (existing === undefined) {
      byId.set(obligation.id, obligation);
      continue;
    }
    if (existing.mandatory && !obligation.mandatory) {
      throw new PlanError("WEAKEN_MANDATORY", `obligation ${obligation.id} cannot weaken mandatory`);
    }
    if (!includesAll(obligation.prerequisites, existing.prerequisites)) {
      throw new PlanError("REMOVE_DEPENDENCY", `obligation ${obligation.id} cannot remove prerequisites`);
    }
    if (existing.claim !== obligation.claim || existing.kind !== obligation.kind) {
      throw new PlanError("REINTERPRET_REQUIREMENT", `obligation ${obligation.id} claim cannot be reinterpreted`);
    }
    byId.set(obligation.id, {
      ...existing,
      mandatory: existing.mandatory || obligation.mandatory,
      prerequisites: unionIds(existing.prerequisites, obligation.prerequisites),
    });
  }
  return [...byId.values()];
}

function mergeChecks(
  previous: readonly CheckNode[],
  added: readonly CheckNode[],
  baselineReproducible: boolean,
): CheckNode[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  for (const check of added) {
    const existing = byId.get(check.id);
    if (existing === undefined) {
      if ((check.subject === "BASELINE" || check.subject === "PAIRED") && !baselineReproducible) {
        throw new PlanError(
          "BASELINE_NOT_REPRODUCIBLE",
          `late check ${check.id} cannot run because the original baseline cannot be reproduced`,
        );
      }
      byId.set(check.id, check);
      continue;
    }
    if (existing.mandatory && !check.mandatory) {
      throw new PlanError("WEAKEN_MANDATORY", `check ${check.id} cannot weaken mandatory`);
    }
    if (!includesAll(check.dependencies, existing.dependencies)) {
      throw new PlanError("REMOVE_DEPENDENCY", `check ${check.id} cannot remove dependencies`);
    }
    if (authorityWeakened(existing.recipe, check.recipe)) {
      throw new PlanError("WEAKEN_AUTHORITY", `check ${check.id} cannot weaken command authority`);
    }
    byId.set(check.id, {
      ...existing,
      mandatory: existing.mandatory || check.mandatory,
      dependencies: unionIds(existing.dependencies, check.dependencies),
    });
  }
  return [...byId.values()];
}

function authorityWeakened(previous: CheckNode["recipe"], next: CheckNode["recipe"]): boolean {
  if (!isCommand(previous) || !isCommand(next)) {
    return false;
  }
  return authorityRank(next.authority) < authorityRank(previous.authority);
}

function isCommand(recipe: CheckNode["recipe"]): recipe is CommandSpec {
  return "executable" in recipe;
}

function includesAll(haystack: readonly string[], needles: readonly string[]): boolean {
  const set = new Set(haystack);
  return needles.every((item) => set.has(item));
}

function unionIds<T extends string>(left: readonly T[], right: readonly T[]): T[] {
  return [...new Set([...left, ...right])];
}

function supplementsForLateChecks(
  previous: VerificationPlan,
  nextChecks: readonly CheckNode[],
  now: string,
  environmentSealObjectDigest: ObjectDigest,
): BaselineSupplement[] {
  const previousIds = new Set(previous.checks.map((item) => item.id));
  const supplements: BaselineSupplement[] = [];
  for (const check of nextChecks) {
    if (previousIds.has(check.id)) {
      continue;
    }
    if (check.subject !== "BASELINE" && check.subject !== "PAIRED") {
      continue;
    }
    supplements.push({
      schemaVersion: 1,
      baselineSealObjectDigest: previous.baselineSealObjectDigest,
      verificationPlanRevision: previous.revision + 1,
      environmentSealObjectDigest,
      observationArtifactObjectDigests: [],
      reason: "CANDIDATE_DISCOVERED_PAIRED_CHECK",
      createdAt: now,
    });
  }
  return supplements;
}
