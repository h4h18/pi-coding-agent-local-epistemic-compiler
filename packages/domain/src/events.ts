import { Compile } from "typebox/compile";
import type { Static } from "typebox";
import {
  EnterStateEventSchema,
  EnterStatePayloadSchema,
  JsonValueSchema,
  RUN_EVENT_TYPES,
  RUN_STATES,
  buildRunEventRegistry,
  type ApprovalId,
  type EnterStateEvent,
  type JsonValue,
  type ObjectDigest,
  type OperationId,
  type RunDomainEvent,
  type RunEventContract,
  type RunEventType,
  type RunState,
} from "@pi-hec/contracts";

const RUN_EVENT_CONTRACTS = buildRunEventRegistry();
const RUN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUN_EVENT_TYPES);
const RUN_STATE_SET: ReadonlySet<string> = new Set(RUN_STATES);
const ENTER_STATE_PAYLOAD = Compile(EnterStatePayloadSchema);
const ENTER_STATE_EVENT = Compile(EnterStateEventSchema);
const JSON_VALUE = Compile(JsonValueSchema);

export type EnterStatePayload = Static<typeof EnterStatePayloadSchema>;

export type EnterStateEventInput = {
  eventId: string;
  projectId: string;
  runId: string;
  expectedStateVersion: number;
  actorType: RunDomainEvent["actorType"];
  actorId: string;
  occurredAt: string;
  target: RunState;
  reasonCode: string;
  inputArtifactObjectDigests?: readonly ObjectDigest[];
  outputArtifactObjectDigests?: readonly ObjectDigest[];
  operationId?: OperationId;
  approvalId?: ApprovalId;
  causationId?: string;
  correlationId?: string;
};

export function enterStateEvent(input: EnterStateEventInput): EnterStateEvent {
  const candidate: unknown = {
    schemaVersion: 1,
    eventId: input.eventId,
    projectId: input.projectId,
    runId: input.runId,
    expectedStateVersion: input.expectedStateVersion,
    actorType: input.actorType,
    actorId: input.actorId,
    occurredAt: input.occurredAt,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    eventType: `ENTER_${input.target}`,
    payload: {
      target: input.target,
      reasonCode: input.reasonCode,
      inputArtifactObjectDigests: [...(input.inputArtifactObjectDigests ?? [])],
      outputArtifactObjectDigests: [...(input.outputArtifactObjectDigests ?? [])],
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    },
  };
  if (!ENTER_STATE_EVENT.Check(candidate)) {
    throw new Error(`invalid enter-state event for target ${JSON.stringify(input.target)}`);
  }
  return candidate;
}

export function getRunEventContract(
  state: RunState,
  eventType: RunEventType,
): RunEventContract | undefined {
  return RUN_EVENT_CONTRACTS[`${state}\0${eventType}`];
}

export function isRunEventType(value: string): value is RunEventType {
  return RUN_EVENT_TYPE_SET.has(value);
}

export function asRunEventType(eventType: string): RunEventType {
  if (!isRunEventType(eventType)) {
    throw new Error(`unhandled union: ${JSON.stringify(eventType)}`);
  }
  return eventType;
}

export function isRunState(value: string): value is RunState {
  return RUN_STATE_SET.has(value);
}

export function enterTargetOf(eventType: RunEventType): RunState {
  const prefix = "ENTER_";
  const target = eventType.startsWith(prefix) ? eventType.slice(prefix.length) : "";
  if (!isRunState(target)) {
    throw new Error(`not an enter-state event: ${JSON.stringify(eventType)}`);
  }
  return target;
}

export function parseEnterStatePayload(payload: unknown): EnterStatePayload {
  if (!ENTER_STATE_PAYLOAD.Check(payload)) {
    throw new Error("invalid enter-state payload");
  }
  return payload;
}

export function asJsonValue(value: unknown): JsonValue {
  if (!JSON_VALUE.Check(value)) {
    throw new Error("invalid JSON value");
  }
  return value;
}

export class IllegalTransitionError extends Error {
  readonly sourceState: RunState;
  readonly eventType: RunEventType;

  constructor(sourceState: RunState, eventType: RunEventType) {
    super(`illegal transition ${sourceState} ${eventType}`);
    this.name = "IllegalTransitionError";
    this.sourceState = sourceState;
    this.eventType = eventType;
  }
}

export function classifyRunEventType(
  eventType: RunEventType,
): "enter" | "cancellation" | "failure" {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- ENTER_* handled in default
  switch (eventType) {
    case "USER_CANCELLATION_REQUESTED":
    case "CANCELLATION_SETTLED":
    case "CANCELLATION_OUTCOME_UNKNOWN":
      return "cancellation";
    case "UNRECOVERABLE_PLATFORM_FAILURE":
      return "failure";
    default: {
      if (!eventType.startsWith("ENTER_")) {
        throw new Error(`unhandled union: ${JSON.stringify(eventType)}`);
      }
      return "enter";
    }
  }
}
