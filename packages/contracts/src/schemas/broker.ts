import { Type, type Static } from "typebox";
import {
  GeneralIdSchema,
  ObjectDigestSchema,
  PositiveSafeUintSchema,
  ProjectIdSchema,
  RunIdSchema,
  SafeUintSchema,
  TimestampSchema,
  closed,
  utf8BoundedString,
} from "../ids.js";
import {
  ApiErrorSchema,
  OperationProjectionSchema,
  RunEventPageSchema,
  RunAgentsPageSchema,
  RunProjectionSchema,
} from "./http.js";
import { ApprovalActionSchema } from "./secrets.js";

export const BrokerHelloSchema = closed({
  protocolVersion: Type.Literal(1),
  brokerInstanceId: GeneralIdSchema,
  connectionId: GeneralIdSchema,
  brokerNonce: utf8BoundedString(128),
  maxFrameBytes: Type.Literal(1048576),
  confinementRequired: Type.Literal(true),
});

export const PiClientHelloSchema = closed({
  protocolVersion: Type.Literal(1),
  connectionId: GeneralIdSchema,
  clientInstanceId: GeneralIdSchema,
  clientNonce: utf8BoundedString(128),
  claimedProcessId: PositiveSafeUintSchema,
  claimedProcessCreationTime: TimestampSchema,
});

export function BrokerFrameSchema<
  TBody extends (Parameters<typeof Type.Object>[0] extends never ? never : object),
>(body: TBody) {
  return closed({
    protocolVersion: Type.Literal(1),
    connectionId: GeneralIdSchema,
    sequence: PositiveSafeUintSchema,
    body,
  });
}

export const BrokerRequestSchema = Type.Union([
  closed({
    requestId: GeneralIdSchema,
    method: Type.Literal("START_RUN"),
    params: closed({
      workspaceAlias: utf8BoundedString(256),
      originalRequest: utf8BoundedString(262144),
      attachmentHandles: Type.Array(utf8BoundedString(256)),
      requestedDeploymentId: Type.Optional(ProjectIdSchema),
    }),
  }),
  closed({
    requestId: GeneralIdSchema,
    method: Type.Literal("GET_RUN_STATUS"),
    params: closed({ runId: RunIdSchema }),
  }),
  closed({
    requestId: GeneralIdSchema,
    method: Type.Literal("POLL_RUN_EVENTS"),
    params: closed({
      runId: RunIdSchema,
      afterSequence: SafeUintSchema,
      limit: Type.Integer({ minimum: 1, maximum: 200 }),
    }),
  }),
  closed({
    requestId: GeneralIdSchema,
    method: Type.Literal("OPEN_TRUSTED_VIEW"),
    params: closed({
      runId: RunIdSchema,
      view: Type.Enum(["CONTEXT", "DIFF", "VERIFICATION", "ARTIFACTS", "EXPORT"] as const),
    }),
  }),
  closed({
    requestId: GeneralIdSchema,
    method: Type.Literal("OPEN_APPROVAL"),
    params: closed({
      runId: Type.Optional(RunIdSchema),
      action: ApprovalActionSchema,
      subjectObjectDigest: ObjectDigestSchema,
    }),
  }),
  closed({
    requestId: GeneralIdSchema,
    method: Type.Literal("PROVIDE_INPUT"),
    params: closed({
      runId: RunIdSchema,
      expectedStateVersion: SafeUintSchema,
      questionId: GeneralIdSchema,
      answer: utf8BoundedString(16384),
    }),
  }),
  closed({
    requestId: GeneralIdSchema,
    method: Type.Literal("REQUEST_REPAIR"),
    params: closed({
      runId: RunIdSchema,
      expectedStateVersion: SafeUintSchema,
      verdictReportObjectDigest: ObjectDigestSchema,
    }),
  }),
  closed({
    requestId: GeneralIdSchema,
    method: Type.Literal("CANCEL_RUN"),
    params: closed({
      runId: RunIdSchema,
      expectedStateVersion: SafeUintSchema,
      reason: utf8BoundedString(16384),
    }),
  }),
  closed({
    requestId: GeneralIdSchema,
    method: Type.Literal("RESUME_RUN"),
    params: closed({ runId: RunIdSchema }),
  }),
  closed({
    requestId: GeneralIdSchema,
    method: Type.Literal("LIST_AGENTS"),
    params: closed({ runId: RunIdSchema }),
  }),
]);

export const BrokerResponseSchema = Type.Union([
  closed({ requestId: GeneralIdSchema, outcome: Type.Literal("RUN"), run: RunProjectionSchema }),
  closed({ requestId: GeneralIdSchema, outcome: Type.Literal("EVENTS"), page: RunEventPageSchema }),
  closed({
    requestId: GeneralIdSchema,
    outcome: Type.Literal("OPERATION_ACCEPTED"),
    operation: OperationProjectionSchema,
  }),
  closed({
    requestId: GeneralIdSchema,
    outcome: Type.Literal("TRUSTED_UI_OPENED"),
    trustedUiSessionId: GeneralIdSchema,
    nonce: utf8BoundedString(128),
  }),
  closed({ requestId: GeneralIdSchema, outcome: Type.Literal("ERROR"), error: ApiErrorSchema }),
  closed({
    requestId: GeneralIdSchema,
    outcome: Type.Literal("AGENTS"),
    agents: RunAgentsPageSchema,
  }),
]);

export const TrustedUiOpenSchema = closed({
  schemaVersion: Type.Literal(1),
  trustedUiSessionId: GeneralIdSchema,
  challengeObjectDigest: ObjectDigestSchema,
  brokerInstanceId: GeneralIdSchema,
  expiresAt: TimestampSchema,
});

export const TrustedUiDecisionRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  trustedUiSessionId: GeneralIdSchema,
  challengeObjectDigest: ObjectDigestSchema,
  decision: Type.Enum(["APPROVE", "DENY"] as const),
  userPresenceProof: utf8BoundedString(4096),
});

export const TrustedUiDecisionResponseSchema = closed({
  schemaVersion: Type.Literal(1),
  outcome: Type.Literal("RECORDED"),
  approvalDecisionObjectDigest: ObjectDigestSchema,
});

export type BrokerHello = Static<typeof BrokerHelloSchema>;
export type PiClientHello = Static<typeof PiClientHelloSchema>;
export type BrokerRequest = Static<typeof BrokerRequestSchema>;
export type BrokerResponse = Static<typeof BrokerResponseSchema>;
export type TrustedUiOpen = Static<typeof TrustedUiOpenSchema>;
export type TrustedUiDecisionRequest = Static<typeof TrustedUiDecisionRequestSchema>;
export type TrustedUiDecisionResponse = Static<typeof TrustedUiDecisionResponseSchema>;
