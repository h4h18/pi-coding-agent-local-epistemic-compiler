import type {
  BaselineSeal,
  CheckNode,
  ProofObligation,
  Requirement,
  VerificationPlan,
} from "@pi-hec/contracts";
import { assertAcyclicPlan } from "./dag.js";
import { mintGeneralId, mintObligationId } from "./ids.js";
import { productionProducers } from "../producers/registry.js";
import { memoryArtifacts } from "../producers/types.js";
import type { ArtifactStore, ProducerBindings, ProducerHost } from "../producers/types.js";

export type PlanP0Input = {
  seal: BaselineSeal;
  requirements: readonly Requirement[];
  host: ProducerHost;
  bindings: ProducerBindings;
  artifacts?: ArtifactStore;
};

export async function buildP0(input: PlanP0Input): Promise<VerificationPlan> {
  const artifacts = input.artifacts ?? memoryArtifacts({});
  const producers = productionProducers(input.host, artifacts, input.bindings);
  const obligations: ProofObligation[] = input.requirements.map((requirement) => obligationFromRequirement(requirement));
  const capabilities = [];
  for (const producer of producers) {
    capabilities.push(...(await producer.probe(input.seal)));
  }
  const checks: CheckNode[] = [];
  const seen = new Set<string>();
  for (const obligation of obligations) {
    for (const producer of producers) {
      const planned = await producer.plan(obligation, capabilities);
      for (const check of planned) {
        if (seen.has(check.id)) {
          continue;
        }
        seen.add(check.id);
        checks.push(check);
      }
    }
  }
  const plan: VerificationPlan = {
    schemaVersion: 1,
    planId: mintGeneralId("plan", input.seal.runId),
    revision: 0,
    baselineSealObjectDigest: input.bindings.baselineSealObjectDigest,
    requirements: [...input.requirements],
    obligations,
    checks,
    baselineSupplementObjectDigests: [],
  };
  assertAcyclicPlan(plan);
  return plan;
}

export function obligationFromRequirement(requirement: Requirement): ProofObligation {
  const kind = kindFromRequirement(requirement);
  return {
    id: mintObligationId({
      requirementIds: [requirement.id],
      claim: requirement.text,
      kind,
    }),
    requirementIds: [requirement.id],
    claim: requirement.text,
    claimMode: requirement.kind === "deterministic-check" ? "EXISTENTIAL" : "UNIVERSAL",
    kind,
    mandatory: requirement.priority === "MUST",
    sourceRefs: requirement.sourceRefs,
    prerequisites: [],
  };
}

function kindFromRequirement(requirement: Requirement): ProofObligation["kind"] {
  switch (requirement.source) {
    case "EXISTING_TEST":
      return "REPRODUCTION";
    case "INFERRED_CHECK":
      return "FUNCTIONAL";
    case "USER_EXPLICIT":
      return "FUNCTIONAL";
    case "PLATFORM_POLICY":
      return "SECURITY";
    case "PROJECT_INSTRUCTION":
      return "FUNCTIONAL";
    case "PUBLIC_CONTRACT":
      return "SOURCE_COMPATIBILITY";
    default: {
      const exhaustive: never = requirement;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}
