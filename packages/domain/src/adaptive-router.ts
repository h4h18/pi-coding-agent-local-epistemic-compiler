import type {
  RiskFlag,
  TaskContract,
  WorkflowProfile,
  WorkflowProfileId,
} from "@pi-hec/contracts";
import {
  compileRunComposition,
  composeFromSignals,
  type ComposeSignals,
} from "./profile-compiler.js";
import { lockProjectAdapter } from "./project-adapter.js";

export const HIGH_RISK_FLAGS: readonly RiskFlag[] = [
  "auth",
  "secrets",
  "crypto",
  "payment",
  "migration",
  "concurrency",
  "public-api",
];

export type RouterSignals = ComposeSignals;

export type ProfileSelection = {
  profileId: WorkflowProfileId;
  profile: WorkflowProfile;
  predicates: readonly string[];
  escalation: readonly string[];
  composition: ReturnType<typeof composeFromSignals>;
  compiled: ReturnType<typeof compileRunComposition>["compiled"];
  blocked: boolean;
};

export function signalsFromContract(contract: TaskContract): RouterSignals {
  return {
    kind: contract.kind,
    riskFlags: contract.riskFlags,
    behaviorChange: contract.specPolicy.behaviorChanges,
    localScope: contract.inScope.length <= 3 && !contract.specPolicy.behaviorChanges,
    reversible: contract.assumptions.every((item) => item.reversible),
    noTests: contract.riskFlags.includes("no-tests"),
    unstableBug: contract.riskFlags.includes("unstable-bug"),
    multiSubsystem: contract.riskFlags.includes("multi-subsystem"),
    externalResearch: false,
  };
}

export function selectWorkflowProfile(signals: RouterSignals): ProfileSelection {
  const composition = composeFromSignals(signals);
  const compiled = compileRunComposition({
    composition,
    adapter: lockProjectAdapter(undefined).adapter,
    signals,
  });
  const escalation: string[] = [];
  if (signals.unstableBug) {
    escalation.push("second-independent-investigator");
  }
  if (signals.riskFlags.includes("auth") || signals.riskFlags.includes("secrets")) {
    escalation.push("security-reviewer");
  }
  if (signals.riskFlags.includes("migration")) {
    escalation.push("migration-plan-dry-run-rollback");
  }
  if (signals.riskFlags.includes("public-api") || signals.multiSubsystem) {
    escalation.push("architecture-reviewer");
  }
  if (signals.noTests) {
    escalation.push("characterization-or-inconclusive");
  }
  return {
    profileId: compiled.compiled.id,
    profile: compiled.compiled,
    predicates: compiled.predicates,
    escalation,
    composition: compiled.compiled.composition,
    compiled: compiled.compiled,
    blocked: compiled.blocked,
  };
}

export function nodeEnabled(nodeWhen: string | undefined, predicates: readonly string[]): boolean {
  if (nodeWhen === undefined) {
    return true;
  }
  if (nodeWhen === "HAS_BLOCKING_FINDINGS") {
    return predicates.includes("HAS_BLOCKING_FINDINGS");
  }
  return predicates.includes(nodeWhen);
}
