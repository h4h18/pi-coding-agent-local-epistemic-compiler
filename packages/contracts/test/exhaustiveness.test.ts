import { expect, test } from "vitest";
import { RUN_STATES, type RunState } from "../src/generated/run-states.js";
import { RUN_EVENT_TYPES, type RunEventType } from "../src/generated/run-event-registry.js";
import { assertNever } from "../src/invariants.js";

function exhaustRunState(state: RunState): string {
  switch (state) {
    case "CREATED":
    case "SNAPSHOT_REQUESTED":
    case "SNAPSHOT_UPLOADING":
    case "SNAPSHOT_VALIDATING":
    case "SNAPSHOT_READY":
    case "INSTRUCTIONS_RESOLVING":
    case "INDEXING":
    case "BASELINE_PLANNING":
    case "AWAITING_BASELINE_COMMAND_APPROVAL":
    case "BASELINE_VERIFYING":
    case "WAITING_BASELINE_ENVIRONMENT":
    case "BASELINE_SEALED":
    case "PREFLIGHT_RUNNING":
    case "PREFLIGHT_COMPLETE":
    case "PREFLIGHT_SATURATED_WITH_UNKNOWNS":
    case "PREFLIGHT_RESOURCE_LIMITED":
    case "AWAITING_REQUIREMENTS_INPUT":
    case "WAITING_PREFLIGHT_RESOURCE":
    case "CONTRACTED":
    case "PROFILE_SELECTED":
    case "PROFILE_RUNNING":
    case "ACCEPTANCE_CHECK":
    case "BLOCKED":
    case "CONTEXT_COMPILING":
    case "WAITING_INITIAL_CONTEXT_CAPACITY":
    case "WAITING_DELTA_CONTEXT_CAPACITY":
    case "WAITING_REPAIR_CONTEXT_CAPACITY":
    case "WAITING_INITIAL_OUTPUT_CAPACITY":
    case "WAITING_DELTA_OUTPUT_CAPACITY":
    case "WAITING_REPAIR_OUTPUT_CAPACITY":
    case "EGRESS_SCANNING":
    case "WAITING_CLOUD_ELIGIBILITY":
    case "AWAITING_EGRESS_APPROVAL":
    case "CLOUD_PREPARED":
    case "CLOUD_DISPATCHING":
    case "CLOUD_IN_FLIGHT":
    case "WAITING_PROVIDER":
    case "CLOUD_OUTCOME_UNKNOWN":
    case "AWAITING_DUPLICATE_CALL_APPROVAL":
    case "CONTEXT_REQUESTED":
    case "CONTEXT_DELTA_COMPILING":
    case "SOLUTION_RECEIVED":
    case "SOLUTION_VALIDATING":
    case "SOLUTION_PROTOCOL_REJECTED":
    case "AWAITING_NEW_CLOUD_CALL_APPROVAL":
    case "AWAITING_CLOUD_INPUT":
    case "NO_CHANGE_VERIFYING":
    case "MATERIALIZING":
    case "VERIFICATION_PLANNING":
    case "AWAITING_CANDIDATE_COMMAND_APPROVAL":
    case "WAITING_VERIFICATION_ENVIRONMENT":
    case "VERIFYING":
    case "VERIFIED_ACCEPTED":
    case "VERIFIED_REJECTED":
    case "VERIFIED_INCONCLUSIVE":
    case "NO_CHANGE_FINALIZING":
    case "REPAIR_PREPARING":
    case "PAUSED_NO_PROGRESS":
    case "AWAITING_VERIFICATION_INPUT":
    case "AWAITING_APPLY_APPROVAL":
    case "APPLY_PREPARING":
    case "APPLYING":
    case "APPLY_RECONCILING":
    case "APPLY_MANUAL_RECOVERY_REQUIRED":
    case "CANCELLATION_PENDING":
    case "SUCCEEDED":
    case "STALE":
    case "CANCELLED":
    case "FAILED":
      return state;
    default: {
      const neverState: never = state;
      return assertNever(neverState);
    }
  }
}

test("RunState switch is exhaustive", () => {
  for (const state of RUN_STATES) {
    expect(exhaustRunState(state)).toBe(state);
  }
});

test("RunEventType covers ENTER targets plus four global events", () => {
  const globals: RunEventType[] = [
    "USER_CANCELLATION_REQUESTED",
    "CANCELLATION_SETTLED",
    "CANCELLATION_OUTCOME_UNKNOWN",
    "UNRECOVERABLE_PLATFORM_FAILURE",
  ];
  for (const eventType of globals) {
    expect(RUN_EVENT_TYPES.includes(eventType)).toBe(true);
  }
  expect(RUN_EVENT_TYPES.length).toBe(RUN_STATES.length - 4 + 4);
});
