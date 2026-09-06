import { Compile } from "typebox/compile";
import { expect, test } from "vitest";
import {
  ENTER_EXCLUDED_STATES,
  ENTER_TARGET_STATES,
  RUN_STATES,
  RunDomainEventSchema,
  asObjectDigest,
  asOperationId,
  asRunId,
  sha256Utf8,
} from "@pi-hec/contracts";
import { enterStateEvent, enterTargetOf, isRunState, type EnterStateEventInput } from "../src/events.js";

const DOMAIN_EVENT = Compile(RunDomainEventSchema);
const RUN_ID = asRunId("run_01900000-0000-7000-8000-000000000042");

function baseInput(target: EnterStateEventInput["target"]): EnterStateEventInput {
  return {
    eventId: `evt-${target}`,
    projectId: "proj-alpha",
    runId: RUN_ID,
    expectedStateVersion: 3,
    actorType: "control",
    actorId: "actor-control",
    occurredAt: "2026-08-27T00:00:00.000Z",
    target,
    reasonCode: "phase",
  };
}

test("enterStateEvent produces a schema-valid ENTER_* event for every enterable state", () => {
  for (const target of ENTER_TARGET_STATES) {
    const event = enterStateEvent(baseInput(target));
    expect(DOMAIN_EVENT.Check(event)).toBe(true);
    expect(event.eventType).toBe(`ENTER_${target}`);
    expect(event.payload.target).toBe(target);
    expect(event.payload.inputArtifactObjectDigests).toEqual([]);
    expect(event.payload.outputArtifactObjectDigests).toEqual([]);
    expect(Object.hasOwn(event, "causationId")).toBe(false);
    expect(Object.hasOwn(event.payload, "operationId")).toBe(false);
  }
});

test("enterStateEvent rejects states that cannot be entered by event", () => {
  for (const target of ENTER_EXCLUDED_STATES) {
    expect(() => enterStateEvent(baseInput(target))).toThrow(`invalid enter-state event for target "${target}"`);
  }
});

test("enterStateEvent copies optional fields only when provided", () => {
  const input = asObjectDigest(sha256Utf8("input"));
  const output = asObjectDigest(sha256Utf8("output"));
  const operationId = asOperationId("op_01900000-0000-7000-8000-000000000007");
  const event = enterStateEvent({
    ...baseInput("SNAPSHOT_REQUESTED"),
    inputArtifactObjectDigests: [input],
    outputArtifactObjectDigests: [output],
    operationId,
    causationId: "evt-cause",
    correlationId: "corr-1",
  });
  expect(DOMAIN_EVENT.Check(event)).toBe(true);
  expect(event.payload.inputArtifactObjectDigests).toEqual([input]);
  expect(event.payload.outputArtifactObjectDigests).toEqual([output]);
  expect(event.payload.operationId).toBe(operationId);
  expect(event.causationId).toBe("evt-cause");
  expect(event.correlationId).toBe("corr-1");
});

test("enterStateEvent rejects malformed identifiers instead of emitting them", () => {
  expect(() => enterStateEvent({ ...baseInput("SNAPSHOT_REQUESTED"), runId: "not-a-run-id" })).toThrow(
    "invalid enter-state event",
  );
});

test("enterTargetOf inverts the ENTER_* naming and refuses non-enter events", () => {
  for (const target of ENTER_TARGET_STATES) {
    expect(enterTargetOf(`ENTER_${target}`)).toBe(target);
  }
  expect(() => enterTargetOf("USER_CANCELLATION_REQUESTED")).toThrow("not an enter-state event");
  expect(() => enterTargetOf("UNRECOVERABLE_PLATFORM_FAILURE")).toThrow("not an enter-state event");
});

test("isRunState agrees with RUN_STATES", () => {
  for (const state of RUN_STATES) {
    expect(isRunState(state)).toBe(true);
  }
  expect(isRunState("ENTER_CREATED")).toBe(false);
  expect(isRunState("")).toBe(false);
  expect(isRunState("created")).toBe(false);
});
