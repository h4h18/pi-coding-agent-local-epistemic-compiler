import { phaseTransitions as PHASE_TRANSITIONS } from "./phase-transitions.js";
import {
  BASE_EDGE_GUARDS,
  ENTER_TARGET_STATES,
  INTERRUPTIBLE_NONTERMINAL_STATES,
  RUN_GUARD_IDS,
  type RunGuardId,
  type RunState,
} from "./run-states.js";

export const RUN_EVENT_TYPES = [
  ...ENTER_TARGET_STATES.map((state) => `ENTER_${state}` as const),
  "USER_CANCELLATION_REQUESTED",
  "CANCELLATION_SETTLED",
  "CANCELLATION_OUTCOME_UNKNOWN",
  "UNRECOVERABLE_PLATFORM_FAILURE",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type RunActorType = "user" | "broker" | "control" | "verifier";

export type RunEventContract = {
  sourceState: RunState;
  eventType: RunEventType;
  targetState: RunState;
  payloadSchemaName: string;
  allowedActorTypes: readonly RunActorType[];
  guardIds: readonly RunGuardId[];
};

const GUARD_ORDER: ReadonlyMap<RunGuardId, number> = new Map(
  RUN_GUARD_IDS.map((id, index) => [id, index]),
);

function sortGuards(guards: readonly RunGuardId[]): RunGuardId[] {
  return [...new Set(guards)].sort((left, right) => {
    const leftIndex = GUARD_ORDER.get(left);
    const rightIndex = GUARD_ORDER.get(right);
    if (leftIndex === undefined || rightIndex === undefined) {
      throw new Error("unknown guard");
    }
    return leftIndex - rightIndex;
  });
}

const COMMAND_EXECUTION_TARGETS: ReadonlySet<RunState> = new Set([
  "BASELINE_VERIFYING",
  "VERIFYING",
]);

const CAPACITY_WAIT_STATES: ReadonlySet<RunState> = new Set([
  "WAITING_INITIAL_CONTEXT_CAPACITY",
  "WAITING_DELTA_CONTEXT_CAPACITY",
  "WAITING_REPAIR_CONTEXT_CAPACITY",
  "WAITING_INITIAL_OUTPUT_CAPACITY",
  "WAITING_DELTA_OUTPUT_CAPACITY",
  "WAITING_REPAIR_OUTPUT_CAPACITY",
]);

const CAPACITY_RESUME: Readonly<Partial<Record<RunState, RunState>>> = {
  WAITING_INITIAL_CONTEXT_CAPACITY: "CONTEXT_COMPILING",
  WAITING_DELTA_CONTEXT_CAPACITY: "CONTEXT_DELTA_COMPILING",
  WAITING_REPAIR_CONTEXT_CAPACITY: "REPAIR_PREPARING",
  WAITING_INITIAL_OUTPUT_CAPACITY: "CONTEXT_COMPILING",
  WAITING_DELTA_OUTPUT_CAPACITY: "CONTEXT_DELTA_COMPILING",
  WAITING_REPAIR_OUTPUT_CAPACITY: "REPAIR_PREPARING",
  WAITING_PREFLIGHT_RESOURCE: "PREFLIGHT_RUNNING",
};

const USER_INPUT_WAIT_STATES: ReadonlySet<RunState> = new Set([
  "AWAITING_REQUIREMENTS_INPUT",
  "AWAITING_CLOUD_INPUT",
  "AWAITING_VERIFICATION_INPUT",
]);

const COMPILER_EGRESS_STATES: ReadonlySet<RunState> = new Set([
  "CONTEXT_COMPILING",
  "CONTEXT_DELTA_COMPILING",
  "REPAIR_PREPARING",
  "EGRESS_SCANNING",
]);

function additionalGuards(source: RunState, target: RunState): RunGuardId[] {
  const extra: RunGuardId[] = [];
  if (COMMAND_EXECUTION_TARGETS.has(target)) {
    extra.push("APPROVAL_VALID_AND_CONSUMED");
  }
  if (target === "CLOUD_PREPARED") {
    extra.push("APPROVAL_VALID_AND_CONSUMED");
  }
  if (
    (source === "WAITING_PROVIDER" && target === "CLOUD_PREPARED") ||
    source === "CLOUD_OUTCOME_UNKNOWN" ||
    ((source === "CLOUD_DISPATCHING" || source === "CLOUD_IN_FLIGHT") &&
      target === "CLOUD_OUTCOME_UNKNOWN")
  ) {
    extra.push("CLOUD_RECOVERY_DECISION_VALID");
  }
  if (COMPILER_EGRESS_STATES.has(source) && CAPACITY_WAIT_STATES.has(target)) {
    extra.push("CAPACITY_FAILURE_VALID");
  }
  if (CAPACITY_RESUME[source] === target) {
    extra.push("CAPACITY_CONSTRAINT_CLEARED");
  }
  if (source === "WAITING_CLOUD_ELIGIBILITY" && target === "EGRESS_SCANNING") {
    extra.push("CLOUD_ELIGIBILITY_SATISFIED");
  }
  if (USER_INPUT_WAIT_STATES.has(source)) {
    extra.push("INPUT_REVISION_COMMITTED");
  }
  if (source === "PAUSED_NO_PROGRESS") {
    extra.push("NO_PROGRESS_CLEARED");
  }
  if (source === "VERIFYING" && target === "VERIFIED_ACCEPTED") {
    extra.push("VERDICT_ACCEPTED_CHANGESET");
  }
  if (source === "NO_CHANGE_VERIFYING" && target === "VERIFIED_ACCEPTED") {
    extra.push("VERDICT_ACCEPTED_NO_CHANGE");
  }
  if (source === "VERIFIED_ACCEPTED" && target === "AWAITING_APPLY_APPROVAL") {
    extra.push("VERDICT_ACCEPTED_CHANGESET");
  }
  if (source === "VERIFIED_ACCEPTED" && target === "NO_CHANGE_FINALIZING") {
    extra.push("VERDICT_ACCEPTED_NO_CHANGE");
  }
  if (
    (source === "VERIFIED_REJECTED" || source === "VERIFIED_INCONCLUSIVE") &&
    target === "REPAIR_PREPARING"
  ) {
    extra.push("REPAIR_ELIGIBLE");
  }
  if (target === "PAUSED_NO_PROGRESS") {
    extra.push("NO_PROGRESS_POLICY_SATISFIED");
  }
  if (target === "APPLY_PREPARING") {
    extra.push("SNAPSHOT_ROOT_CURRENT", "APPROVAL_VALID_AND_CONSUMED");
  }
  if (
    (source === "APPLY_PREPARING" && target === "APPLYING") ||
    (source === "APPLYING" && target === "APPLY_RECONCILING")
  ) {
    extra.push("APPLY_JOURNAL_VALID");
  }
  if (source === "APPLY_RECONCILING" && target === "SUCCEEDED") {
    extra.push("APPLY_RECEIPT_COMMITTED");
  }
  if (source === "APPLY_RECONCILING" && target === "AWAITING_APPLY_APPROVAL") {
    extra.push("APPLY_RECEIPT_ROLLED_BACK");
  }
  if (source === "APPLY_RECONCILING" && target === "STALE") {
    extra.push("APPLY_RECEIPT_STALE");
  }
  if (source === "APPLY_RECONCILING" && target === "APPLY_MANUAL_RECOVERY_REQUIRED") {
    extra.push("APPLY_RECEIPT_MANUAL_RECOVERY_REQUIRED");
  }
  if (source === "NO_CHANGE_FINALIZING" && target === "SUCCEEDED") {
    extra.push("NO_CHANGE_RECEIPT_VALID", "SNAPSHOT_ROOT_CURRENT");
  }
  return extra;
}

function isEnterEvent(
  eventType: RunEventType,
): eventType is Extract<RunEventType, `ENTER_${string}`> {
  return eventType.startsWith("ENTER_");
}

function payloadSchemaName(eventType: RunEventType): string {
  if (isEnterEvent(eventType)) {
    return "EnterStatePayload";
  }
  switch (eventType) {
    case "USER_CANCELLATION_REQUESTED":
      return "UserCancellationRequestedPayload";
    case "CANCELLATION_SETTLED":
      return "CancellationSettledPayload";
    case "CANCELLATION_OUTCOME_UNKNOWN":
      return "CancellationOutcomeUnknownPayload";
    case "UNRECOVERABLE_PLATFORM_FAILURE":
      return "UnrecoverablePlatformFailurePayload";
    default: {
      const exhaustive: never = eventType;
      return exhaustive;
    }
  }
}

function buildPhaseContracts(): RunEventContract[] {
  const contracts: RunEventContract[] = [];
  for (const [source, targets] of Object.entries(PHASE_TRANSITIONS) as [
    RunState,
    readonly RunState[],
  ][]) {
    for (const target of targets) {
      const eventType = `ENTER_${target}` as RunEventType;
      if (!ENTER_TARGET_STATES.includes(target as (typeof ENTER_TARGET_STATES)[number])) {
        throw new Error(`phase edge ${source} -> ${target} is not an ENTER target`);
      }
      contracts.push({
        sourceState: source,
        eventType,
        targetState: target,
        payloadSchemaName: payloadSchemaName(eventType),
        allowedActorTypes: ["control"],
        guardIds: sortGuards([...BASE_EDGE_GUARDS, ...additionalGuards(source, target)]),
      });
    }
  }
  return contracts;
}

function buildGlobalContracts(): RunEventContract[] {
  const contracts: RunEventContract[] = [];
  for (const source of INTERRUPTIBLE_NONTERMINAL_STATES) {
    contracts.push({
      sourceState: source,
      eventType: "USER_CANCELLATION_REQUESTED",
      targetState: "CANCELLATION_PENDING",
      payloadSchemaName: "UserCancellationRequestedPayload",
      allowedActorTypes: ["user"],
      guardIds: sortGuards([...BASE_EDGE_GUARDS, "CANCELLATION_INTERRUPTIBLE"]),
    });
    contracts.push({
      sourceState: source,
      eventType: "UNRECOVERABLE_PLATFORM_FAILURE",
      targetState: "FAILED",
      payloadSchemaName: "UnrecoverablePlatformFailurePayload",
      allowedActorTypes: ["control", "broker"],
      guardIds: sortGuards([...BASE_EDGE_GUARDS, "FAILURE_UNRECOVERABLE"]),
    });
  }
  contracts.push({
    sourceState: "CANCELLATION_PENDING",
    eventType: "CANCELLATION_SETTLED",
    targetState: "CANCELLED",
    payloadSchemaName: "CancellationSettledPayload",
    allowedActorTypes: ["control", "broker"],
    guardIds: sortGuards([...BASE_EDGE_GUARDS]),
  });
  contracts.push({
    sourceState: "CANCELLATION_PENDING",
    eventType: "CANCELLATION_OUTCOME_UNKNOWN",
    targetState: "CLOUD_OUTCOME_UNKNOWN",
    payloadSchemaName: "CancellationOutcomeUnknownPayload",
    allowedActorTypes: ["control", "broker"],
    guardIds: sortGuards([...BASE_EDGE_GUARDS, "CLOUD_RECOVERY_DECISION_VALID"]),
  });
  return contracts;
}

function registryKey(sourceState: RunState, eventType: RunEventType): string {
  return `${sourceState}\0${eventType}`;
}

export function buildRunEventRegistry(): Readonly<Record<string, RunEventContract>> {
  const registry: Record<string, RunEventContract> = {};
  for (const contract of [...buildPhaseContracts(), ...buildGlobalContracts()]) {
    const key = registryKey(contract.sourceState, contract.eventType);
    if (Object.hasOwn(registry, key)) {
      throw new Error(
        `duplicate run-event registry key for ${contract.sourceState} ${contract.eventType}`,
      );
    }
    if (contract.eventType.startsWith("ENTER_")) {
      const suffix = contract.eventType.slice("ENTER_".length);
      if (suffix !== contract.targetState) {
        throw new Error(`ENTER target mismatch ${contract.eventType} vs ${contract.targetState}`);
      }
    }
    registry[key] = contract;
  }
  return registry;
}

export const RUN_EVENT_REGISTRY = buildRunEventRegistry();
