import {
  SAFE_INTEGER_MAX,
  type ObjectDigest,
  type OperationId,
  type RunDomainEvent,
  type RunEventContract,
  type RunProjection,
  type RunTransitionEvent,
} from "@pi-hec/contracts";
import {
  asObjectDigest,
  asOperationId,
  asRunEventType,
  getRunEventContract,
  IllegalTransitionError,
  parseEnterStatePayload,
} from "./events.js";
import { evaluateGuard } from "./guards.js";
import { projectionArtifactRoles, type VerifiedArtifactSet } from "./run-state.js";

const SUCCESSFUL_RUN_RESULT_ROLE = "successful-run-result";

export function reduceRun(
  projection: RunProjection,
  event: RunDomainEvent,
  artifacts: VerifiedArtifactSet,
): { projection: RunProjection; transition: RunTransitionEvent } {
  const eventType = asRunEventType(event.eventType);
  const contract = getRunEventContract(projection.state, eventType);
  if (contract === undefined) {
    throw new IllegalTransitionError(projection.state, eventType);
  }
  if (!contract.allowedActorTypes.includes(event.actorType)) {
    throw new IllegalTransitionError(projection.state, eventType);
  }
  for (const guardId of contract.guardIds) {
    evaluateGuard(guardId, projection, event, artifacts);
  }
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- ENTER_* handled in default
  switch (eventType) {
    case "USER_CANCELLATION_REQUESTED":
      return applyCancellationRequested(projection, event, contract, artifacts);
    case "CANCELLATION_SETTLED":
      if (event.eventType !== "CANCELLATION_SETTLED") {
        throw new IllegalTransitionError(projection.state, eventType);
      }
      return applyCancellationSettled(projection, event, contract, artifacts);
    case "CANCELLATION_OUTCOME_UNKNOWN":
      if (event.eventType !== "CANCELLATION_OUTCOME_UNKNOWN") {
        throw new IllegalTransitionError(projection.state, eventType);
      }
      return applyCancellationUnknown(projection, event, contract, artifacts);
    case "UNRECOVERABLE_PLATFORM_FAILURE":
      if (event.eventType !== "UNRECOVERABLE_PLATFORM_FAILURE") {
        throw new IllegalTransitionError(projection.state, eventType);
      }
      return applyPlatformFailure(projection, event, contract, artifacts);
    default: {
      if (!eventType.startsWith("ENTER_")) {
        throw new Error(`unhandled union: ${JSON.stringify(eventType)}`);
      }
      return applyEnterState(projection, event, contract, artifacts);
    }
  }
}

function asObjectDigests(values: readonly string[]): ObjectDigest[] {
  return values.map(asObjectDigest);
}

function applyEnterState(
  projection: RunProjection,
  event: RunDomainEvent,
  contract: RunEventContract,
  artifacts: VerifiedArtifactSet,
): { projection: RunProjection; transition: RunTransitionEvent } {
  const payload = parseEnterStatePayload(event.payload);
  if (payload.target !== contract.targetState) {
    throw new IllegalTransitionError(projection.state, asRunEventType(event.eventType));
  }
  const fields: {
    inputArtifactObjectDigests: readonly ObjectDigest[];
    outputArtifactObjectDigests: readonly ObjectDigest[];
    reasonCode: string;
    activeOperationId?: OperationId;
  } = {
    inputArtifactObjectDigests: asObjectDigests(payload.inputArtifactObjectDigests),
    outputArtifactObjectDigests: asObjectDigests(payload.outputArtifactObjectDigests),
    reasonCode: payload.reasonCode,
  };
  if (payload.operationId !== undefined) {
    fields.activeOperationId = asOperationId(payload.operationId);
  }
  return commitTransition(projection, event, contract, artifacts, fields);
}

function applyCancellationRequested(
  projection: RunProjection,
  event: RunDomainEvent,
  contract: RunEventContract,
  artifacts: VerifiedArtifactSet,
): { projection: RunProjection; transition: RunTransitionEvent } {
  return commitTransition(projection, event, contract, artifacts, {
    inputArtifactObjectDigests: [],
    outputArtifactObjectDigests: [],
    reasonCode: "USER_CANCELLATION_REQUESTED",
  });
}

function applyCancellationSettled(
  projection: RunProjection,
  event: Extract<RunDomainEvent, { eventType: "CANCELLATION_SETTLED" }>,
  contract: RunEventContract,
  artifacts: VerifiedArtifactSet,
): { projection: RunProjection; transition: RunTransitionEvent } {
  return commitTransition(projection, event, contract, artifacts, {
    inputArtifactObjectDigests: [],
    outputArtifactObjectDigests: [asObjectDigest(event.payload.cancellationReceiptObjectDigest)],
    reasonCode: event.payload.providerOutcome,
  });
}

function applyCancellationUnknown(
  projection: RunProjection,
  event: Extract<RunDomainEvent, { eventType: "CANCELLATION_OUTCOME_UNKNOWN" }>,
  contract: RunEventContract,
  artifacts: VerifiedArtifactSet,
): { projection: RunProjection; transition: RunTransitionEvent } {
  return commitTransition(projection, event, contract, artifacts, {
    inputArtifactObjectDigests: [],
    outputArtifactObjectDigests: [asObjectDigest(event.payload.cancellationReceiptObjectDigest)],
    reasonCode: event.payload.providerOutcome,
  });
}

function applyPlatformFailure(
  projection: RunProjection,
  event: Extract<RunDomainEvent, { eventType: "UNRECOVERABLE_PLATFORM_FAILURE" }>,
  contract: RunEventContract,
  artifacts: VerifiedArtifactSet,
): { projection: RunProjection; transition: RunTransitionEvent } {
  return commitTransition(projection, event, contract, artifacts, {
    inputArtifactObjectDigests: asObjectDigests(event.payload.recoveryAttemptObjectDigests),
    outputArtifactObjectDigests: [asObjectDigest(event.payload.failureArtifactObjectDigest)],
    reasonCode: "UNRECOVERABLE_PLATFORM_FAILURE",
  });
}

function successfulRunResultDigest(artifacts: VerifiedArtifactSet): ObjectDigest | undefined {
  return artifacts.bindings.find((binding) => binding.role === SUCCESSFUL_RUN_RESULT_ROLE)
    ?.objectDigest;
}

function commitTransition(
  projection: RunProjection,
  event: RunDomainEvent,
  contract: RunEventContract,
  artifacts: VerifiedArtifactSet,
  fields: {
    inputArtifactObjectDigests: readonly ObjectDigest[];
    outputArtifactObjectDigests: readonly ObjectDigest[];
    reasonCode: string;
    activeOperationId?: OperationId;
  },
): { projection: RunProjection; transition: RunTransitionEvent } {
  const sequence = projection.stateVersion + 1;
  if (sequence > SAFE_INTEGER_MAX) {
    throw new IllegalTransitionError(projection.state, asRunEventType(event.eventType));
  }
  const transition: RunTransitionEvent = {
    schemaVersion: 1,
    eventId: event.eventId,
    eventType: asRunEventType(event.eventType),
    projectId: event.projectId,
    runId: event.runId,
    sequence,
    previousState: projection.state,
    nextState: contract.targetState,
    actorType: event.actorType,
    actorId: event.actorId,
    inputArtifactObjectDigests: [...fields.inputArtifactObjectDigests],
    outputArtifactObjectDigests: [...fields.outputArtifactObjectDigests],
    reasonCode: fields.reasonCode,
    occurredAt: event.occurredAt,
  };
  if (event.causationId !== undefined) {
    transition.causationId = event.causationId;
  }
  if (event.correlationId !== undefined) {
    transition.correlationId = event.correlationId;
  }
  const next: RunProjection = {
    schemaVersion: 1,
    projectId: projection.projectId,
    runId: projection.runId,
    workspaceId: projection.workspaceId,
    state: contract.targetState,
    stateVersion: sequence,
    artifactRoles: projectionArtifactRoles(artifacts),
    updatedAt: event.occurredAt,
  };
  if (projection.snapshotId !== undefined) {
    next.snapshotId = projection.snapshotId;
  }
  if (fields.activeOperationId !== undefined) {
    next.activeOperationId = fields.activeOperationId;
  }
  if (contract.targetState === "SUCCEEDED") {
    const digest = successfulRunResultDigest(artifacts);
    if (digest !== undefined) {
      next.terminalResultObjectDigest = digest;
    }
  }
  return { projection: next, transition };
}
