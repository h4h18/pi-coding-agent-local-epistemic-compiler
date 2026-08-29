import {
  INTERRUPTIBLE_NONTERMINAL_STATES,
  type RunDomainEvent,
  type RunGuardId,
  type RunProjection,
  type RunState,
} from "@pi-hec/contracts";
import { asRunEventType, parseEnterStatePayload } from "./events.js";
import {
  artifactRolesSatisfyState,
  presentRolesOf,
  type VerifiedArtifactSet,
} from "./run-state.js";

export class GuardFailureError extends Error {
  readonly guardId: RunGuardId;

  constructor(guardId: RunGuardId) {
    super(`guard failed: ${guardId}`);
    this.name = "GuardFailureError";
    this.guardId = guardId;
  }
}

const INTERRUPTIBLE = new Set<RunState>(INTERRUPTIBLE_NONTERMINAL_STATES);

function requireFact(guardId: RunGuardId, artifacts: VerifiedArtifactSet): void {
  if (!artifacts.satisfiedGuards.has(guardId)) {
    throw new GuardFailureError(guardId);
  }
}

export function targetStateOf(event: RunDomainEvent): RunState {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- ENTER_* handled in default
  switch (asRunEventType(event.eventType)) {
    case "USER_CANCELLATION_REQUESTED":
      return "CANCELLATION_PENDING";
    case "CANCELLATION_SETTLED":
      return "CANCELLED";
    case "CANCELLATION_OUTCOME_UNKNOWN":
      return "CLOUD_OUTCOME_UNKNOWN";
    case "UNRECOVERABLE_PLATFORM_FAILURE":
      return "FAILED";
    default: {
      return parseEnterStatePayload(event.payload).target;
    }
  }
}

export function evaluateGuard(
  guardId: RunGuardId,
  projection: RunProjection,
  event: RunDomainEvent,
  artifacts: VerifiedArtifactSet,
): void {
  switch (guardId) {
    case "SOURCE_STATE_VERSION_MATCHES":
      if (event.expectedStateVersion !== projection.stateVersion) {
        throw new GuardFailureError(guardId);
      }
      return;
    case "REQUIRED_ARTIFACT_ROLES_PRESENT":
      if (!artifactRolesSatisfyState(presentRolesOf(artifacts), targetStateOf(event))) {
        throw new GuardFailureError(guardId);
      }
      return;
    case "ARTIFACT_SIGNATURES_VALID":
      if (!artifacts.signaturesValid) {
        throw new GuardFailureError(guardId);
      }
      return;
    case "CANCELLATION_INTERRUPTIBLE":
      if (!INTERRUPTIBLE.has(projection.state)) {
        throw new GuardFailureError(guardId);
      }
      return;
    case "FAILURE_UNRECOVERABLE":
      if (asRunEventType(event.eventType) !== "UNRECOVERABLE_PLATFORM_FAILURE") {
        throw new GuardFailureError(guardId);
      }
      return;
    case "APPROVAL_VALID_AND_CONSUMED":
    case "SNAPSHOT_ROOT_CURRENT":
    case "CLOUD_RECOVERY_DECISION_VALID":
    case "VERDICT_ACCEPTED_CHANGESET":
    case "VERDICT_ACCEPTED_NO_CHANGE":
    case "REPAIR_ELIGIBLE":
    case "NO_PROGRESS_POLICY_SATISFIED":
    case "APPLY_JOURNAL_VALID":
    case "APPLY_RECEIPT_COMMITTED":
    case "NO_CHANGE_RECEIPT_VALID":
    case "CAPACITY_FAILURE_VALID":
    case "CAPACITY_CONSTRAINT_CLEARED":
    case "CLOUD_ELIGIBILITY_SATISFIED":
    case "NO_PROGRESS_CLEARED":
    case "INPUT_REVISION_COMMITTED":
    case "APPLY_RECEIPT_ROLLED_BACK":
    case "APPLY_RECEIPT_STALE":
    case "APPLY_RECEIPT_MANUAL_RECOVERY_REQUIRED":
      requireFact(guardId, artifacts);
      return;
    default: {
      const exhaustive: never = guardId;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}
