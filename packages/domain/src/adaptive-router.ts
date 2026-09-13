import type {
  RiskFlag,
  TaskContract,
  TaskKind,
  WorkflowProfile,
  WorkflowProfileId,
} from "@pi-hec/contracts";
import { workflowProfileById } from "./profile-catalog.js";

export const HIGH_RISK_FLAGS: readonly RiskFlag[] = [
  "auth",
  "secrets",
  "crypto",
  "payment",
  "migration",
  "concurrency",
  "public-api",
];

export type RouterSignals = {
  kind: TaskKind;
  riskFlags: readonly RiskFlag[];
  fileCountHint?: number;
  behaviorChange: boolean;
  localScope: boolean;
  reversible: boolean;
  noTests: boolean;
  unstableBug: boolean;
  multiSubsystem: boolean;
  externalResearch: boolean;
};

export type ProfileSelection = {
  profileId: WorkflowProfileId;
  profile: WorkflowProfile;
  predicates: readonly string[];
  escalation: readonly string[];
};

function highRisk(flags: readonly RiskFlag[]): boolean {
  return flags.some((flag) => HIGH_RISK_FLAGS.includes(flag));
}

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
  const escalation: string[] = [];
  const predicates: string[] = [];
  if (signals.unstableBug) {
    predicates.push("UNSTABLE_BUG");
    escalation.push("second-independent-investigator");
  }
  if (signals.externalResearch) {
    predicates.push("EXTERNAL_RESEARCH");
  }
  if (highRisk(signals.riskFlags) || signals.multiSubsystem) {
    predicates.push("HIGH_RISK");
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

  let profileId: WorkflowProfileId;
  switch (signals.kind) {
    case "research":
      profileId = "RESEARCH";
      break;
    case "spec":
      profileId = "SPEC_ONLY";
      break;
    case "refactor":
      profileId = highRisk(signals.riskFlags) || signals.multiSubsystem ? "HIGH_RISK" : "REFACTOR";
      break;
    case "bugfix":
      if (highRisk(signals.riskFlags) || signals.multiSubsystem) {
        profileId = "HIGH_RISK";
      } else if (signals.localScope && signals.reversible && !signals.behaviorChange) {
        profileId = "FAST";
      } else {
        profileId = "BUGFIX";
      }
      break;
    case "feature":
      if (highRisk(signals.riskFlags) || signals.multiSubsystem) {
        profileId = "HIGH_RISK";
      } else if (signals.localScope && signals.reversible && !signals.behaviorChange) {
        profileId = "FAST";
      } else {
        profileId = "FEATURE";
      }
      break;
    default: {
      const exhaustive: never = signals.kind;
      throw new Error(`unhandled task kind ${String(exhaustive)}`);
    }
  }

  return {
    profileId,
    profile: workflowProfileById(profileId),
    predicates,
    escalation,
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
