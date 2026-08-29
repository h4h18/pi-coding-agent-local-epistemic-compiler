import { assert, constantFrom, integer, property, tuple } from "fast-check";
import { expect, test } from "vitest";
import {
  BASE_EDGE_GUARDS,
  ENTER_TARGET_STATES,
  RUN_EVENT_TYPES,
  RUN_GUARD_IDS,
  STATE_INVARIANTS,
  TERMINAL_RUN_STATES,
  phaseTransitions,
  sha256Utf8,
  type ObjectDigest,
  type RunDomainEvent,
  type RunEventType,
  type RunGuardId,
  type RunId,
  type RunProjection,
  type RunState,
} from "@pi-hec/contracts";
import {
  asRunEventType,
  classifyRunEventType,
  getRunEventContract,
  IllegalTransitionError,
} from "../src/events.js";
import { evaluateGuard, GuardFailureError } from "../src/guards.js";
import { reduceRun } from "../src/reducer.js";
import { createRunProjection, legalRoleSets, type VerifiedArtifactSet } from "../src/run-state.js";

const OCCURRED_AT = "2026-08-27T00:00:00.000Z";
const PROJECT_ID = "proj-alpha";
const WORKSPACE_ID = "ws-alpha";
const RUN_ID = "run_01900000-0000-7000-8000-000000000001" as RunId;

function digestOf(label: string): ObjectDigest {
  return sha256Utf8(label) as ObjectDigest;
}

function initialProjection(): RunProjection {
  return createRunProjection({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    occurredAt: OCCURRED_AT,
    taskEnvelopeDigest: digestOf("task-envelope"),
  });
}

function projectionIn(state: RunState, stateVersion = 0): RunProjection {
  return { ...initialProjection(), state, stateVersion };
}

function extraGuards(guardIds: readonly RunGuardId[]): RunGuardId[] {
  return guardIds.filter((id) => !(BASE_EDGE_GUARDS as readonly string[]).includes(id));
}

function artifactsForState(
  state: RunState,
  satisfiedGuards: readonly RunGuardId[] = [],
  options: { signaturesValid?: boolean; roles?: readonly string[] } = {},
): VerifiedArtifactSet {
  const roles = options.roles ?? legalRoleSets(state)[0] ?? [];
  return {
    bindings: roles.map((role) => ({ role, objectDigest: digestOf(role) })),
    signaturesValid: options.signaturesValid ?? true,
    satisfiedGuards: new Set(satisfiedGuards),
  };
}

function enterEvent(
  projection: RunProjection,
  target: RunState,
  actorType: RunDomainEvent["actorType"] = "control",
): RunDomainEvent {
  return {
    schemaVersion: 1,
    eventId: `evt-enter-${target}`,
    projectId: projection.projectId,
    runId: projection.runId,
    expectedStateVersion: projection.stateVersion,
    actorType,
    actorId: `actor-${actorType}`,
    occurredAt: OCCURRED_AT,
    eventType: `ENTER_${target}`,
    payload: {
      target,
      reasonCode: "phase",
      inputArtifactObjectDigests: [],
      outputArtifactObjectDigests: [],
    },
  } as RunDomainEvent;
}

function cancelEvent(
  projection: RunProjection,
  actorType: RunDomainEvent["actorType"] = "user",
): RunDomainEvent {
  return {
    schemaVersion: 1,
    eventId: "evt-cancel",
    projectId: projection.projectId,
    runId: projection.runId,
    expectedStateVersion: projection.stateVersion,
    actorType,
    actorId: `actor-${actorType}`,
    occurredAt: OCCURRED_AT,
    eventType: "USER_CANCELLATION_REQUESTED",
    payload: { reason: "user-cancel" },
  };
}

function failureEvent(
  projection: RunProjection,
  actorType: RunDomainEvent["actorType"] = "control",
): RunDomainEvent {
  return {
    schemaVersion: 1,
    eventId: "evt-fail",
    projectId: projection.projectId,
    runId: projection.runId,
    expectedStateVersion: projection.stateVersion,
    actorType,
    actorId: `actor-${actorType}`,
    occurredAt: OCCURRED_AT,
    eventType: "UNRECOVERABLE_PLATFORM_FAILURE",
    payload: {
      failureArtifactObjectDigest: digestOf("failure"),
      recoveryAttemptObjectDigests: [],
    },
  };
}

function settledEvent(projection: RunProjection): RunDomainEvent {
  return {
    schemaVersion: 1,
    eventId: "evt-settled",
    projectId: projection.projectId,
    runId: projection.runId,
    expectedStateVersion: projection.stateVersion,
    actorType: "control",
    actorId: "actor-control",
    occurredAt: OCCURRED_AT,
    eventType: "CANCELLATION_SETTLED",
    payload: {
      cancellationReceiptObjectDigest: digestOf("cancellation-receipt"),
      providerOutcome: "NOT_DISPATCHED",
    },
  };
}

function eventForType(projection: RunProjection, eventType: RunEventType): RunDomainEvent {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- ENTER_* handled in default
  switch (eventType) {
    case "USER_CANCELLATION_REQUESTED":
      return cancelEvent(projection);
    case "CANCELLATION_SETTLED":
      return settledEvent(projection);
    case "CANCELLATION_OUTCOME_UNKNOWN":
      return {
        schemaVersion: 1,
        eventId: "evt-unknown",
        projectId: projection.projectId,
        runId: projection.runId,
        expectedStateVersion: projection.stateVersion,
        actorType: "control",
        actorId: "actor-control",
        occurredAt: OCCURRED_AT,
        eventType: "CANCELLATION_OUTCOME_UNKNOWN",
        payload: {
          cancellationReceiptObjectDigest: digestOf("cancellation-receipt"),
          providerOutcome: "UNKNOWN",
        },
      };
    case "UNRECOVERABLE_PLATFORM_FAILURE":
      return failureEvent(projection);
    default:
      return enterEvent(projection, eventType.slice("ENTER_".length) as RunState);
  }
}

function reduceEnter(source: RunState, target: RunState): ReturnType<typeof reduceRun> {
  const projection = projectionIn(source);
  const event = enterEvent(projection, target);
  const contract = getRunEventContract(source, event.eventType);
  if (contract === undefined) {
    throw new Error(`missing contract ${source} ${event.eventType}`);
  }
  return reduceRun(projection, event, artifactsForState(target, extraGuards(contract.guardIds)));
}

test("every PHASE_TRANSITIONS edge accepts ENTER_* from control when invariants hold", () => {
  for (const [source, targets] of Object.entries(phaseTransitions) as [
    RunState,
    readonly RunState[],
  ][]) {
    for (const target of targets) {
      const result = reduceEnter(source, target);
      expect(result.projection.state).toBe(target);
      expect(result.transition.previousState).toBe(source);
      expect(result.transition.nextState).toBe(target);
      expect(result.transition.sequence).toBe(1);
      expect(result.projection.stateVersion).toBe(1);
      expect(result.projection.updatedAt).toBe(OCCURRED_AT);
    }
  }
});

test("every forbidden ENTER pair throws IllegalTransitionError", () => {
  for (const source of Object.keys(phaseTransitions) as RunState[]) {
    const allowed = new Set(phaseTransitions[source]);
    for (const target of ENTER_TARGET_STATES) {
      if (allowed.has(target)) {
        continue;
      }
      const projection = projectionIn(source);
      const event = enterEvent(projection, target);
      expect(() => reduceRun(projection, event, artifactsForState(target))).toThrow(
        IllegalTransitionError,
      );
    }
  }
});

test("cancel from SNAPSHOT_READY enters CANCELLATION_PENDING", () => {
  const projection = projectionIn("SNAPSHOT_READY");
  const result = reduceRun(
    projection,
    cancelEvent(projection),
    artifactsForState("CANCELLATION_PENDING"),
  );
  expect(result.projection.state).toBe("CANCELLATION_PENDING");
  expect(result.transition.nextState).toBe("CANCELLATION_PENDING");
});

test("cancel from SUCCEEDED throws IllegalTransitionError", () => {
  const projection = projectionIn("SUCCEEDED");
  expect(() =>
    reduceRun(projection, cancelEvent(projection), artifactsForState("CANCELLATION_PENDING")),
  ).toThrow(IllegalTransitionError);
});

test("unrecoverable failure from interruptible SNAPSHOT_READY enters FAILED", () => {
  const projection = projectionIn("SNAPSHOT_READY");
  const result = reduceRun(projection, failureEvent(projection), artifactsForState("FAILED"));
  expect(result.projection.state).toBe("FAILED");
  expect(result.transition.sequence).toBe(1);
});

test("user cannot fire ENTER_*", () => {
  const projection = projectionIn("CREATED");
  const event = enterEvent(projection, "SNAPSHOT_REQUESTED", "user");
  expect(() => reduceRun(projection, event, artifactsForState("SNAPSHOT_REQUESTED"))).toThrow(
    IllegalTransitionError,
  );
});

test("missing required roles fail REQUIRED_ARTIFACT_ROLES_PRESENT", () => {
  const projection = projectionIn("SNAPSHOT_VALIDATING");
  const event = enterEvent(projection, "SNAPSHOT_READY");
  const artifacts = artifactsForState("SNAPSHOT_READY", [], {
    roles: ["task-envelope"],
  });
  try {
    reduceRun(projection, event, artifacts);
    expect.fail("expected guard failure");
  } catch (error) {
    expect(error).toBeInstanceOf(GuardFailureError);
    expect((error as GuardFailureError).guardId).toBe("REQUIRED_ARTIFACT_ROLES_PRESENT");
  }
});

function expectGuardFailure(
  run: () => unknown,
  guardId: RunGuardId,
): void {
  try {
    run();
    expect.fail(`expected ${guardId}`);
  } catch (error) {
    expect(error).toBeInstanceOf(GuardFailureError);
    expect((error as GuardFailureError).guardId).toBe(guardId);
  }
}

test("alternativeRoleSets are the only legal sets when present", () => {
  const invariant = STATE_INVARIANTS.find((entry) => entry.state === "CLOUD_OUTCOME_UNKNOWN");
  expect(invariant?.alternativeRoleSets).toBeDefined();
  const projection = projectionIn("CLOUD_DISPATCHING");
  const event = enterEvent(projection, "CLOUD_OUTCOME_UNKNOWN");
  const contract = getRunEventContract("CLOUD_DISPATCHING", event.eventType);
  expect(contract).toBeDefined();
  const artifacts = artifactsForState(
    "CLOUD_OUTCOME_UNKNOWN",
    extraGuards(contract?.guardIds ?? []),
    {
      roles: invariant?.requiredRoles,
    },
  );
  expectGuardFailure(
    () => reduceRun(projection, event, artifacts),
    "REQUIRED_ARTIFACT_ROLES_PRESENT",
  );
});

test("SUCCEEDED alternativeRoleSets reject requiredRoles alone and accept each alternative set", () => {
  const invariant = STATE_INVARIANTS.find((entry) => entry.state === "SUCCEEDED");
  expect(invariant?.alternativeRoleSets).toBeDefined();
  const projection = projectionIn("APPLY_RECONCILING");
  const event = enterEvent(projection, "SUCCEEDED");
  const contract = getRunEventContract("APPLY_RECONCILING", event.eventType);
  expect(contract).toBeDefined();
  expectGuardFailure(
    () =>
      reduceRun(
        projection,
        event,
        artifactsForState("SUCCEEDED", extraGuards(contract?.guardIds ?? []), {
          roles: invariant?.requiredRoles,
        }),
      ),
    "REQUIRED_ARTIFACT_ROLES_PRESENT",
  );
  for (const roles of invariant?.alternativeRoleSets ?? []) {
    const source = roles.includes("apply-receipt") ? "APPLY_RECONCILING" : "NO_CHANGE_FINALIZING";
    const sourceProjection = projectionIn(source);
    const sourceEvent = enterEvent(sourceProjection, "SUCCEEDED");
    const sourceContract = getRunEventContract(source, sourceEvent.eventType);
    const result = reduceRun(
      sourceProjection,
      sourceEvent,
      artifactsForState("SUCCEEDED", extraGuards(sourceContract?.guardIds ?? []), { roles }),
    );
    expect(result.projection.state).toBe("SUCCEEDED");
  }
});

test("VERIFIED_ACCEPTED alternativeRoleSets accept each set and reject a non-alternative set", () => {
  const invariant = STATE_INVARIANTS.find((entry) => entry.state === "VERIFIED_ACCEPTED");
  expect(invariant?.alternativeRoleSets).toBeDefined();
  const projection = projectionIn("VERIFYING");
  const event = enterEvent(projection, "VERIFIED_ACCEPTED");
  const contract = getRunEventContract("VERIFYING", event.eventType);
  expect(contract).toBeDefined();
  for (const roles of invariant?.alternativeRoleSets ?? []) {
    const result = reduceRun(
      projection,
      event,
      artifactsForState("VERIFIED_ACCEPTED", extraGuards(contract?.guardIds ?? []), { roles }),
    );
    expect(result.projection.state).toBe("VERIFIED_ACCEPTED");
  }
  expectGuardFailure(
    () =>
      reduceRun(
        projection,
        event,
        artifactsForState("VERIFIED_ACCEPTED", extraGuards(contract?.guardIds ?? []), {
          roles: ["task-envelope"],
        }),
      ),
    "REQUIRED_ARTIFACT_ROLES_PRESENT",
  );
});

test("invalid signatures fail ARTIFACT_SIGNATURES_VALID", () => {
  const projection = projectionIn("CREATED");
  const event = enterEvent(projection, "SNAPSHOT_REQUESTED");
  try {
    reduceRun(
      projection,
      event,
      artifactsForState("SNAPSHOT_REQUESTED", [], { signaturesValid: false }),
    );
    expect.fail("expected guard failure");
  } catch (error) {
    expect(error).toBeInstanceOf(GuardFailureError);
    expect((error as GuardFailureError).guardId).toBe("ARTIFACT_SIGNATURES_VALID");
  }
});

test("state version mismatch fails SOURCE_STATE_VERSION_MATCHES", () => {
  const projection = projectionIn("CREATED", 0);
  const event = {
    ...enterEvent(projection, "SNAPSHOT_REQUESTED"),
    expectedStateVersion: 7,
  };
  try {
    reduceRun(projection, event, artifactsForState("SNAPSHOT_REQUESTED"));
    expect.fail("expected guard failure");
  } catch (error) {
    expect(error).toBeInstanceOf(GuardFailureError);
    expect((error as GuardFailureError).guardId).toBe("SOURCE_STATE_VERSION_MATCHES");
  }
});

test("property: terminal states reject every event type", () => {
  assert(
    property(
      constantFrom(...TERMINAL_RUN_STATES),
      constantFrom(...RUN_EVENT_TYPES),
      (state, eventType) => {
        const projection = projectionIn(state);
        expect(() =>
          reduceRun(projection, eventForType(projection, eventType), artifactsForState(state)),
        ).toThrow(IllegalTransitionError);
      },
    ),
    { numRuns: 64 },
  );
});

test("property: replay of the same sequence is deterministic", () => {
  assert(
    property(tuple(integer({ min: 0, max: 99 }), integer({ min: 1, max: 12 })), ([, steps]) => {
      const recorded: Array<{ event: RunDomainEvent; artifacts: VerifiedArtifactSet }> = [];
      let projection = initialProjection();
      for (let index = 0; index < steps; index += 1) {
        const targets = phaseTransitions[projection.state];
        const target = targets[index % Math.max(targets.length, 1)];
        if (target === undefined) {
          break;
        }
        const event = enterEvent(projection, target);
        const contract = getRunEventContract(projection.state, event.eventType);
        if (contract === undefined) {
          break;
        }
        const artifacts = artifactsForState(target, extraGuards(contract.guardIds));
        const result = reduceRun(projection, event, artifacts);
        recorded.push({ event, artifacts });
        projection = result.projection;
      }
      let replayed = initialProjection();
      for (const step of recorded) {
        replayed = reduceRun(replayed, step.event, step.artifacts).projection;
      }
      expect(replayed).toEqual(projection);
    }),
    { numRuns: 32 },
  );
});

test("property: event sequence is strictly monotonic", () => {
  assert(
    property(integer({ min: 1, max: 12 }), (steps) => {
      const sequences: number[] = [];
      let projection = initialProjection();
      for (let index = 0; index < steps; index += 1) {
        const targets = phaseTransitions[projection.state];
        const target = targets[0];
        if (target === undefined) {
          break;
        }
        const event = enterEvent(projection, target);
        const contract = getRunEventContract(projection.state, event.eventType);
        if (contract === undefined) {
          break;
        }
        const result = reduceRun(
          projection,
          event,
          artifactsForState(target, extraGuards(contract.guardIds)),
        );
        sequences.push(result.transition.sequence);
        projection = result.projection;
      }
      for (let index = 1; index < sequences.length; index += 1) {
        const previous = sequences[index - 1];
        const current = sequences[index];
        expect(previous).toBeDefined();
        expect(current).toBeDefined();
        expect(current).toBeGreaterThan(previous ?? 0);
      }
      if (sequences.length > 0) {
        expect(sequences[0]).toBe(1);
      }
    }),
    { numRuns: 32 },
  );
});

test("SUCCEEDED sets terminalResultObjectDigest from successful-run-result", () => {
  const projection = projectionIn("APPLY_RECONCILING");
  const event = enterEvent(projection, "SUCCEEDED");
  const contract = getRunEventContract("APPLY_RECONCILING", event.eventType);
  const decoy = digestOf("not-success");
  const eventWithDecoy = {
    ...event,
    payload: {
      target: "SUCCEEDED",
      reasonCode: "phase",
      inputArtifactObjectDigests: [],
      outputArtifactObjectDigests: [decoy],
    },
  } as RunDomainEvent;
  const result = reduceRun(
    projection,
    eventWithDecoy,
    artifactsForState("SUCCEEDED", extraGuards(contract?.guardIds ?? [])),
  );
  expect(result.projection.state).toBe("SUCCEEDED");
  expect(result.projection.terminalResultObjectDigest).toBe(digestOf("successful-run-result"));
  expect(result.projection.terminalResultObjectDigest).not.toBe(decoy);
});

test("FAILED omits terminalResultObjectDigest", () => {
  const projection = projectionIn("SNAPSHOT_READY");
  const result = reduceRun(projection, failureEvent(projection), artifactsForState("FAILED"));
  expect(result.projection.state).toBe("FAILED");
  expect(result.projection.terminalResultObjectDigest).toBeUndefined();
});

test("CANCELLED omits terminalResultObjectDigest", () => {
  const projection = projectionIn("CANCELLATION_PENDING");
  const result = reduceRun(
    projection,
    settledEvent(projection),
    artifactsForState("CANCELLED"),
  );
  expect(result.projection.state).toBe("CANCELLED");
  expect(result.projection.terminalResultObjectDigest).toBeUndefined();
});

test("APPROVAL_VALID_AND_CONSUMED missing throws", () => {
  const projection = projectionIn("AWAITING_EGRESS_APPROVAL");
  const event = enterEvent(projection, "CLOUD_PREPARED");
  const contract = getRunEventContract("AWAITING_EGRESS_APPROVAL", event.eventType);
  const withoutApproval = extraGuards(contract?.guardIds ?? []).filter(
    (guardId) => guardId !== "APPROVAL_VALID_AND_CONSUMED",
  );
  expectGuardFailure(
    () => reduceRun(projection, event, artifactsForState("CLOUD_PREPARED", withoutApproval)),
    "APPROVAL_VALID_AND_CONSUMED",
  );
});

test("CLOUD_RECOVERY_DECISION_VALID missing on CLOUD_DISPATCHING→CLOUD_OUTCOME_UNKNOWN throws", () => {
  const projection = projectionIn("CLOUD_DISPATCHING");
  const event = enterEvent(projection, "CLOUD_OUTCOME_UNKNOWN");
  const contract = getRunEventContract("CLOUD_DISPATCHING", event.eventType);
  const withoutRecovery = extraGuards(contract?.guardIds ?? []).filter(
    (guardId) => guardId !== "CLOUD_RECOVERY_DECISION_VALID",
  );
  expectGuardFailure(
    () =>
      reduceRun(
        projection,
        event,
        artifactsForState("CLOUD_OUTCOME_UNKNOWN", withoutRecovery),
      ),
    "CLOUD_RECOVERY_DECISION_VALID",
  );
});

test("missing extra guards fail closed on exercised phase edges", () => {
  const seen = new Set<RunGuardId>();
  for (const [source, targets] of Object.entries(phaseTransitions) as [
    RunState,
    readonly RunState[],
  ][]) {
    for (const target of targets) {
      const projection = projectionIn(source);
      const event = enterEvent(projection, target);
      const contract = getRunEventContract(source, event.eventType);
      if (contract === undefined) {
        throw new Error(`missing contract ${source} ${event.eventType}`);
      }
      for (const missing of extraGuards(contract.guardIds)) {
        seen.add(missing);
        const remaining = extraGuards(contract.guardIds).filter((guardId) => guardId !== missing);
        expectGuardFailure(
          () => reduceRun(projection, event, artifactsForState(target, remaining)),
          missing,
        );
      }
    }
  }
  expect(seen.size).toBeGreaterThan(0);
});

test("asRunEventType validates against RUN_EVENT_TYPES", () => {
  for (const eventType of RUN_EVENT_TYPES) {
    expect(asRunEventType(eventType)).toBe(eventType);
  }
  expect(() => asRunEventType("INVENTED")).toThrow(/unhandled union/);
});

test("RunEventType classification is exhaustive", () => {
  for (const eventType of RUN_EVENT_TYPES) {
    expect(["enter", "cancellation", "failure"]).toContain(classifyRunEventType(eventType));
  }
  expect(() => classifyRunEventType("INVENTED" as RunEventType)).toThrow(/unhandled union/);
});

test("every RunGuardId is handled by evaluateGuard", () => {
  const projection = projectionIn("CREATED");
  const event = enterEvent(projection, "SNAPSHOT_REQUESTED");
  const artifacts = artifactsForState("SNAPSHOT_REQUESTED", [...RUN_GUARD_IDS]);
  for (const guardId of RUN_GUARD_IDS) {
    try {
      evaluateGuard(guardId, projection, event, artifacts);
    } catch (error) {
      expect(error).toBeInstanceOf(GuardFailureError);
    }
  }
});
