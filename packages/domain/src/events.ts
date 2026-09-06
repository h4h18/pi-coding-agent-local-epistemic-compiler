import { Compile } from "typebox/compile";
import type { Static } from "typebox";
import {
  EnterStatePayloadSchema,
  JsonValueSchema,
  RUN_EVENT_TYPES,
  buildRunEventRegistry,
  type JsonValue,
  type RunEventContract,
  type RunEventType,
  type RunState,
} from "@pi-hec/contracts";

const RUN_EVENT_CONTRACTS = buildRunEventRegistry();
const RUN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUN_EVENT_TYPES);
const ENTER_STATE_PAYLOAD = Compile(EnterStatePayloadSchema);
const JSON_VALUE = Compile(JsonValueSchema);

export type EnterStatePayload = Static<typeof EnterStatePayloadSchema>;

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
