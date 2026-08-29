import { Type, type Static } from "typebox";
import { ENTER_TARGET_STATES, OPERATION_KINDS, RUN_STATES } from "../generated/run-states.js";
import { RUN_EVENT_TYPES } from "../generated/run-event-registry.js";
import {
  ApprovalIdSchema,
  CloudCallIdSchema,
  ConfidenceSchema,
  DigestSchema,
  EvidenceIdSchema,
  GeneralIdSchema,
  NormalizedPathSchema,
  ObjectDigestSchema,
  OperationIdSchema,
  ProjectIdSchema,
  ReasonSchema,
  RequirementIdSchema,
  RunIdSchema,
  SafeUintSchema,
  SnapshotIdSchema,
  TaskTextSchema,
  TimestampSchema,
  type authenticatedScopeBrand,
  closed,
  utf8BoundedString,
} from "../ids.js";
import {
  CommandSpecSchema,
  InstructionManifestSchema,
  ProvenanceSchema,
  SkillDescriptorSchema,
  SkillManifestSchema,
  SourceRefSchema,
  TrustVectorSchema,
} from "./artifacts.js";

export const RunStateSchema = Type.Enum(RUN_STATES);
export const OperationKindSchema = Type.Enum(OPERATION_KINDS);

export const UserScopeSchema = closed({
  allowedPathGlobs: Type.Array(utf8BoundedString(1024), { maxItems: 128 }),
  forbiddenPathGlobs: Type.Array(utf8BoundedString(1024), { maxItems: 128 }),
  forbiddenOperations: Type.Array(utf8BoundedString(256), { maxItems: 64 }),
});

export const TaskEnvelopeSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  originalRequest: TaskTextSchema,
  originalRequestDigest: DigestSchema,
  userScope: UserScopeSchema,
  attachments: Type.Array(SourceRefSchema),
  requestedDeploymentId: Type.Optional(ProjectIdSchema),
  requestedVerificationCommands: Type.Array(CommandSpecSchema),
  createdAt: TimestampSchema,
});

const RequirementBaseFields = {
  id: RequirementIdSchema,
  text: utf8BoundedString(16384),
  sourceRefs: Type.Array(SourceRefSchema),
  priority: Type.Enum(["MUST", "SHOULD"] as const),
  state: Type.Enum(["CLEAR", "AMBIGUOUS", "CONFLICTING"] as const),
};

export const RequirementSchema = Type.Union([
  closed({
    ...RequirementBaseFields,
    kind: Type.Literal("authoritative"),
    source: Type.Enum([
      "USER_EXPLICIT",
      "PLATFORM_POLICY",
      "PROJECT_INSTRUCTION",
      "PUBLIC_CONTRACT",
    ] as const),
    normative: Type.Literal(true),
  }),
  closed({
    ...RequirementBaseFields,
    kind: Type.Literal("deterministic-check"),
    source: Type.Enum(["EXISTING_TEST", "INFERRED_CHECK"] as const),
    normative: Type.Literal(false),
  }),
]);

export const AuthoritativeRequirementSchema = closed({
  ...RequirementBaseFields,
  kind: Type.Literal("authoritative"),
  source: Type.Enum([
    "USER_EXPLICIT",
    "PLATFORM_POLICY",
    "PROJECT_INSTRUCTION",
    "PUBLIC_CONTRACT",
  ] as const),
  normative: Type.Literal(true),
});

export const RequirementLedgerSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  originalRequest: TaskTextSchema,
  originalRequestDigest: DigestSchema,
  requirements: Type.Array(RequirementSchema),
  nonGoals: Type.Array(AuthoritativeRequirementSchema),
  conflicts: Type.Array(
    closed({
      id: GeneralIdSchema,
      requirementIds: Type.Array(RequirementIdSchema, { minItems: 2 }),
      explanation: ReasonSchema,
      sourceRefs: Type.Array(SourceRefSchema),
    }),
  ),
  openQuestions: Type.Array(
    closed({
      id: GeneralIdSchema,
      question: utf8BoundedString(16384),
      correctnessImpact: Type.Enum(["blocking", "material", "advisory"] as const),
      sourceRefs: Type.Array(SourceRefSchema),
    }),
  ),
});

export const EvidenceNodeKindSchema = Type.Enum([
  "task",
  "requirement",
  "constraint",
  "invariant",
  "directory",
  "file",
  "symbol",
  "code-region",
  "test",
  "test-result",
  "coverage-region",
  "stack-frame",
  "dependency",
  "build-config",
  "schema",
  "api-contract",
  "commit",
  "diff-hunk",
  "instruction",
  "fact",
  "hypothesis",
  "risk",
  "unknown",
  "conflict",
  "external-documentation",
] as const);

export const EvidenceRelationSchema = Type.Enum([
  "CONTAINS",
  "DEFINES",
  "EXTENDS",
  "IMPLEMENTS",
  "IMPORTS",
  "REFERENCES",
  "MAY_CALL",
  "CALLS_OBSERVED",
  "READS",
  "WRITES",
  "FLOWS_TO",
  "SANITIZES",
  "COVERED_BY",
  "FAILS_AT",
  "PRODUCES",
  "CHANGED_WITH",
  "INTRODUCED_BY",
  "BLAMES",
  "SUPPORTS",
  "CONTRADICTS",
  "DERIVED_FROM",
  "RESOLVES",
  "SATISFIES",
  "AFFECTS",
  "CANDIDATE_LOCUS",
  "APPLIES_TO",
  "OVERRIDES",
] as const);

export const EvidenceEdgeKindSchema = EvidenceRelationSchema;

export const EvidenceNodeSchema = closed({
  id: EvidenceIdSchema,
  kind: EvidenceNodeKindSchema,
  identityKey: utf8BoundedString(1024),
  authorship: Type.Enum(["DETERMINISTIC", "USER", "LOCAL_MODEL", "CLOUD_MODEL"] as const),
  label: utf8BoundedString(1024),
  contentObjectDigest: Type.Optional(ObjectDigestSchema),
  status: Type.Enum(["verified", "probable", "unknown", "conflicted", "invalidated"] as const),
  trust: TrustVectorSchema,
  provenance: Type.Array(ProvenanceSchema),
  estimatedTokens: SafeUintSchema,
});

export const EvidenceEdgeSchema = closed({
  id: GeneralIdSchema,
  from: EvidenceIdSchema,
  to: EvidenceIdSchema,
  relation: EvidenceRelationSchema,
  polarity: Type.Enum(["positive", "negative"] as const),
  confidence: ConfidenceSchema,
  provenance: Type.Array(ProvenanceSchema),
});

export const EvidenceGraphSchema = closed({
  schemaVersion: Type.Literal(1),
  snapshotId: SnapshotIdSchema,
  nodes: Type.Array(EvidenceNodeSchema),
  edges: Type.Array(EvidenceEdgeSchema),
});

export const EvidenceBundleSchema = closed({
  id: GeneralIdSchema,
  purpose: Type.Enum([
    "requirement-witness",
    "causal-path",
    "interface-contract",
    "regression-surface",
    "runtime-observation",
    "counter-evidence",
    "instruction-scope",
    "verification-capability",
  ] as const),
  nodeIds: Type.Array(EvidenceIdSchema),
  edgeIds: Type.Array(GeneralIdSchema),
  exactSourceRefs: Type.Array(SourceRefSchema),
  mandatory: Type.Boolean(),
});

export const InlineSourcePayloadSchema = closed({
  sourceRef: SourceRefSchema,
  mediaType: utf8BoundedString(256),
  content: Type.Union([
    closed({ encoding: Type.Literal("utf-8"), text: Type.String({ minLength: 1 }) }),
    closed({ encoding: Type.Literal("base64"), base64: Type.String({ minLength: 1 }) }),
  ]),
});

export const InlineEvidencePayloadSchema = closed({
  evidenceId: EvidenceIdSchema,
  node: EvidenceNodeSchema,
  sources: Type.Tuple([
    InlineSourcePayloadSchema,
    Type.Rest(Type.Array(InlineSourcePayloadSchema)),
  ]),
});

export const LoadedSkillBodySchema = closed({
  skillId: GeneralIdSchema,
  descriptor: SkillDescriptorSchema,
  verbatimContent: Type.String({ minLength: 1 }),
});

export const ChangeOperationKindSchema = Type.Enum([
  "text_patch",
  "create_text",
  "create_directory",
  "write_binary",
  "delete",
  "delete_directory",
  "move",
  "set_git_mode",
  "symlink",
] as const);

export const CloudControlEnvelopeSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  role: Type.Literal("CLOUD_EXECUTOR"),
  userScope: UserScopeSchema,
  allowedResultKinds: Type.Tuple([
    Type.Literal("submit_solution"),
    Type.Literal("request_context"),
  ]),
  allowedChangeOperations: Type.Array(ChangeOperationKindSchema),
  forbiddenCapabilities: Type.Tuple([
    Type.Literal("generic-read"),
    Type.Literal("shell"),
    Type.Literal("workspace-write"),
    Type.Literal("git-mutation"),
    Type.Literal("secret-access"),
    Type.Literal("deployment"),
  ]),
  resultSchemaObjectDigest: ObjectDigestSchema,
  contextRequestPolicy: closed({
    existingUnresolvedClaimsOnly: Type.Literal(true),
    cumulativeEgressReapproval: Type.Literal(true),
  }),
});

export const VerificationCapabilitySchema = closed({
  schemaVersion: Type.Literal(1),
  id: GeneralIdSchema,
  producerId: GeneralIdSchema,
  subjectKinds: Type.Array(utf8BoundedString(256)),
  platform: utf8BoundedString(64),
  sourceRefs: Type.Array(SourceRefSchema),
});

export const ContextPacketSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  snapshotId: SnapshotIdSchema,
  snapshotRootDigest: DigestSchema,
  requirementLedgerObjectDigest: ObjectDigestSchema,
  instructionManifestObjectDigest: ObjectDigestSchema,
  skillManifestObjectDigest: ObjectDigestSchema,
  control: CloudControlEnvelopeSchema,
  requirementLedger: RequirementLedgerSchema,
  instructionManifest: InstructionManifestSchema,
  skillManifest: SkillManifestSchema,
  authoritativeInstructions: Type.Array(
    closed({
      scope: utf8BoundedString(1024),
      precedence: SafeUintSchema,
      sourceRef: SourceRefSchema,
      verbatimContent: Type.String({ minLength: 1 }),
    }),
  ),
  repositoryMap: Type.Array(
    closed({
      path: NormalizedPathSchema,
      kind: utf8BoundedString(256),
      symbols: Type.Array(utf8BoundedString(1024)),
      relationIds: Type.Array(GeneralIdSchema),
    }),
  ),
  bundles: Type.Array(EvidenceBundleSchema),
  relations: Type.Array(EvidenceEdgeSchema),
  evidencePayloads: Type.Array(InlineEvidencePayloadSchema),
  loadedSkills: Type.Array(LoadedSkillBodySchema),
  verifiedFacts: Type.Array(EvidenceIdSchema),
  unknowns: Type.Array(EvidenceIdSchema),
  conflicts: Type.Array(EvidenceIdSchema),
  risks: Type.Array(EvidenceIdSchema),
  verificationCapabilities: Type.Array(VerificationCapabilitySchema),
  omissionManifest: closed({
    omittedEvidenceRootDigest: DigestSchema,
    countsByReason: closed({
      duplicate: SafeUintSchema,
      "lower-utility": SafeUintSchema,
      untrusted: SafeUintSchema,
      "window-capacity": SafeUintSchema,
    }),
    criticalOmissions: Type.Array(
      closed({
        evidenceId: EvidenceIdSchema,
        reason: Type.Enum(["untrusted", "window-capacity"] as const),
      }),
    ),
  }),
  tokenization: closed({
    deploymentId: ProjectIdSchema,
    inputTokens: SafeUintSchema,
    reservedOutputTokens: SafeUintSchema,
    tokenizerRevision: GeneralIdSchema,
  }),
});

export const ContextDeltaSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  priorContextPacketObjectDigest: ObjectDigestSchema,
  requestedByCloudCallId: CloudCallIdSchema,
  evidenceBundles: Type.Array(EvidenceBundleSchema),
  resolvedClaimIds: Type.Array(EvidenceIdSchema),
  stillUnresolvedClaimIds: Type.Array(EvidenceIdSchema),
});

export const ClosureReportSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  snapshotId: SnapshotIdSchema,
  state: Type.Enum(["COMPLETE", "SATURATED_WITH_UNKNOWNS", "RESOURCE_LIMITED"] as const),
  evidenceGraphObjectDigest: ObjectDigestSchema,
  requirementWitnesses: Type.Array(
    closed({
      requirementId: RequirementIdSchema,
      bundleIds: Type.Array(GeneralIdSchema),
      status: Type.Enum(["covered", "unknown", "conflicted"] as const),
    }),
  ),
  unresolvedCriticalEvidenceIds: Type.Array(EvidenceIdSchema),
  exhaustedActionDigests: Type.Array(DigestSchema),
  stabilityAuditObjectDigest: ObjectDigestSchema,
});

export const ActorTypeSchema = Type.Enum(["user", "broker", "control", "verifier"] as const);

export const EnterStatePayloadSchema = closed({
  target: RunStateSchema,
  reasonCode: GeneralIdSchema,
  inputArtifactObjectDigests: Type.Array(ObjectDigestSchema),
  outputArtifactObjectDigests: Type.Array(ObjectDigestSchema),
  operationId: Type.Optional(OperationIdSchema),
  approvalId: Type.Optional(ApprovalIdSchema),
});

const RunEventBaseFields = {
  schemaVersion: Type.Literal(1),
  eventId: GeneralIdSchema,
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  expectedStateVersion: SafeUintSchema,
  actorType: ActorTypeSchema,
  actorId: GeneralIdSchema,
  causationId: Type.Optional(GeneralIdSchema),
  correlationId: Type.Optional(GeneralIdSchema),
  occurredAt: TimestampSchema,
};

export const EnterStateEventSchema = Type.Union(
  ENTER_TARGET_STATES.map((target) =>
    closed({
      ...RunEventBaseFields,
      eventType: Type.Literal(`ENTER_${target}`),
      payload: closed({
        target: Type.Literal(target),
        reasonCode: GeneralIdSchema,
        inputArtifactObjectDigests: Type.Array(ObjectDigestSchema),
        outputArtifactObjectDigests: Type.Array(ObjectDigestSchema),
        operationId: Type.Optional(OperationIdSchema),
        approvalId: Type.Optional(ApprovalIdSchema),
      }),
    }),
  ),
);

export const RunDomainEventSchema = Type.Union([
  EnterStateEventSchema,
  closed({
    ...RunEventBaseFields,
    eventType: Type.Literal("USER_CANCELLATION_REQUESTED"),
    payload: closed({
      reason: ReasonSchema,
      outstandingOperationId: Type.Optional(OperationIdSchema),
    }),
  }),
  closed({
    ...RunEventBaseFields,
    eventType: Type.Literal("CANCELLATION_SETTLED"),
    payload: closed({
      cancellationReceiptObjectDigest: ObjectDigestSchema,
      providerOutcome: Type.Enum(["NOT_DISPATCHED", "CANCELLED", "COMPLETED_DISCARDED"] as const),
    }),
  }),
  closed({
    ...RunEventBaseFields,
    eventType: Type.Literal("CANCELLATION_OUTCOME_UNKNOWN"),
    payload: closed({
      cancellationReceiptObjectDigest: ObjectDigestSchema,
      providerOutcome: Type.Literal("UNKNOWN"),
    }),
  }),
  closed({
    ...RunEventBaseFields,
    eventType: Type.Literal("UNRECOVERABLE_PLATFORM_FAILURE"),
    payload: closed({
      failureArtifactObjectDigest: ObjectDigestSchema,
      recoveryAttemptObjectDigests: Type.Array(ObjectDigestSchema),
    }),
  }),
]);

const CancellableStates = RUN_STATES.filter(
  (state) =>
    state !== "CANCELLATION_PENDING" &&
    state !== "SUCCEEDED" &&
    state !== "STALE" &&
    state !== "CANCELLED" &&
    state !== "FAILED" &&
    state !== "APPLY_MANUAL_RECOVERY_REQUIRED",
);

export const CancellationReceiptSchema = Type.Union([
  closed({
    schemaVersion: Type.Literal(1),
    runId: RunIdSchema,
    cancellationRequestEventId: GeneralIdSchema,
    suspendedState: Type.Enum(CancellableStates),
    outcome: Type.Literal("SETTLED"),
    settlement: Type.Union([
      closed({ kind: Type.Literal("NOT_DISPATCHED") }),
      closed({
        kind: Type.Literal("CANCELLED"),
        target: Type.Union([
          closed({ kind: Type.Literal("operation"), operationId: OperationIdSchema }),
          closed({ kind: Type.Literal("cloud-call"), cloudCallId: CloudCallIdSchema }),
        ]),
        evidenceObjectDigest: ObjectDigestSchema,
      }),
      closed({
        kind: Type.Literal("COMPLETED_DISCARDED"),
        cloudCallId: CloudCallIdSchema,
        cloudCompletionReceiptObjectDigest: ObjectDigestSchema,
      }),
    ]),
    completedAt: TimestampSchema,
  }),
  closed({
    schemaVersion: Type.Literal(1),
    runId: RunIdSchema,
    cancellationRequestEventId: GeneralIdSchema,
    suspendedState: Type.Enum(["CLOUD_DISPATCHING", "CLOUD_IN_FLIGHT"] as const),
    outcome: Type.Literal("UNKNOWN"),
    cloudCallId: CloudCallIdSchema,
    transportEvidenceObjectDigest: ObjectDigestSchema,
    recoveryDeadlineAt: TimestampSchema,
    completedAt: TimestampSchema,
  }),
]);

export const RunTransitionEventSchema = closed({
  schemaVersion: Type.Literal(1),
  eventId: GeneralIdSchema,
  eventType: Type.Enum(RUN_EVENT_TYPES),
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  sequence: SafeUintSchema,
  previousState: RunStateSchema,
  nextState: RunStateSchema,
  actorType: ActorTypeSchema,
  actorId: GeneralIdSchema,
  causationId: Type.Optional(GeneralIdSchema),
  correlationId: Type.Optional(GeneralIdSchema),
  inputArtifactObjectDigests: Type.Array(ObjectDigestSchema),
  outputArtifactObjectDigests: Type.Array(ObjectDigestSchema),
  reasonCode: GeneralIdSchema,
  occurredAt: TimestampSchema,
});

export const PrincipalScopeSchema = closed({
  principalId: GeneralIdSchema,
  identityKind: Type.Enum(["admin", "broker", "runner", "worker", "service"] as const),
  certificateSerial: GeneralIdSchema,
  audiences: Type.Array(utf8BoundedString(256)),
  projectGrants: Type.Array(
    closed({
      projectId: ProjectIdSchema,
      roles: Type.Array(utf8BoundedString(64)),
      grantObjectDigest: ObjectDigestSchema,
    }),
  ),
  authenticatedAt: TimestampSchema,
});

export const ProjectScopeSchema = closed({
  principalId: GeneralIdSchema,
  identityKind: Type.Enum(["admin", "broker", "runner", "worker", "service"] as const),
  certificateSerial: GeneralIdSchema,
  audiences: Type.Array(utf8BoundedString(256)),
  projectGrants: Type.Array(
    closed({
      projectId: ProjectIdSchema,
      roles: Type.Array(utf8BoundedString(64)),
      grantObjectDigest: ObjectDigestSchema,
    }),
  ),
  authenticatedAt: TimestampSchema,
  projectId: ProjectIdSchema,
  projectRoles: Type.Array(utf8BoundedString(64)),
  projectGrantObjectDigest: ObjectDigestSchema,
});

export type TaskEnvelope = Static<typeof TaskEnvelopeSchema>;
export type Requirement = Static<typeof RequirementSchema>;
export type AuthoritativeRequirement = Static<typeof AuthoritativeRequirementSchema>;
export type RequirementLedger = Static<typeof RequirementLedgerSchema>;
export type EvidenceNode = Static<typeof EvidenceNodeSchema>;
export type EvidenceEdge = Static<typeof EvidenceEdgeSchema>;
export type EvidenceGraph = Static<typeof EvidenceGraphSchema>;
export type EvidenceBundle = Static<typeof EvidenceBundleSchema>;
export type ContextPacket = Static<typeof ContextPacketSchema>;
export type RunDomainEvent = Static<typeof RunDomainEventSchema>;
export type CancellationReceipt = Static<typeof CancellationReceiptSchema>;
export type RunTransitionEvent = Static<typeof RunTransitionEventSchema>;
export type PrincipalScope = Static<typeof PrincipalScopeSchema> & {
  readonly [authenticatedScopeBrand]: true;
};
export type ProjectScope = Static<typeof ProjectScopeSchema> & {
  readonly [authenticatedScopeBrand]: true;
};
export type EvidenceNodeKind = Static<typeof EvidenceNodeKindSchema>;
export type EvidenceRelation = Static<typeof EvidenceRelationSchema>;
export type ClosureReport = Static<typeof ClosureReportSchema>;
export type ContextDelta = Static<typeof ContextDeltaSchema>;
export type VerificationCapability = Static<typeof VerificationCapabilitySchema>;
