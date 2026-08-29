import { Type, type Static } from "typebox";
import {
  ArtifactEnvelopeSchema,
  Base64Schema,
  CloudCallIdSchema,
  DigestSchema,
  DomainDigestSchema,
  EvidenceIdSchema,
  GeneralIdSchema,
  JsonValueSchema,
  MoneySchema,
  NormalizedPathSchema,
  ObjectDigestSchema,
  ProjectIdSchema,
  ReasonSchema,
  RequirementIdSchema,
  RunIdSchema,
  SafeUintSchema,
  SnapshotIdSchema,
  TimestampSchema,
  closed,
  utf8BoundedString,
} from "../ids.js";
import { GitFileModeSchema as FileMode, SourceRefSchema } from "./artifacts.js";
import { EvidenceNodeKindSchema } from "./run.js";

export const CloudResultBindingSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  cloudCallId: CloudCallIdSchema,
  requestBindingDigest: DomainDigestSchema,
  contextPacketObjectDigest: ObjectDigestSchema,
  baseSnapshotId: SnapshotIdSchema,
  baseSnapshotRootDigest: DigestSchema,
});

export const ContextRequestSchema = Type.Object(
  {
    ...CloudResultBindingSchema.properties,
    kind: Type.Literal("request_context"),
    missingClaimIds: Type.Array(EvidenceIdSchema, { minItems: 1, maxItems: 32 }),
    requestedEvidenceKinds: Type.Array(EvidenceNodeKindSchema, { maxItems: 16 }),
    pathOrSymbolHints: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32 }),
    requestedSkillIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 16 }),
    reason: Type.String({ minLength: 1, maxLength: 16384 }),
  },
  { additionalProperties: false },
);

export const ChangeOperationSchema = Type.Union([
  closed({
    kind: Type.Literal("text_patch"),
    path: NormalizedPathSchema,
    expectedBeforeDigest: DigestSchema,
    expectedAfterDigest: DigestSchema,
    unifiedDiff: Type.String({ minLength: 1 }),
    insertedLineEnding: Type.Enum(["LF", "CRLF"] as const),
    finalNewline: Type.Enum(["PRESENT", "ABSENT"] as const),
  }),
  closed({
    kind: Type.Literal("create_text"),
    path: NormalizedPathSchema,
    content: Type.String(),
    expectedAfterDigest: DigestSchema,
    gitMode: FileMode,
    expectedAbsent: Type.Literal(true),
  }),
  closed({
    kind: Type.Literal("create_directory"),
    path: NormalizedPathSchema,
    expectedAbsent: Type.Literal(true),
  }),
  closed({
    kind: Type.Literal("write_binary"),
    path: NormalizedPathSchema,
    expectedBeforeDigest: Type.Union([DigestSchema, Type.Null()]),
    mediaType: utf8BoundedString(256),
    base64Content: Base64Schema,
    expectedAfterDigest: DigestSchema,
    gitMode: FileMode,
  }),
  closed({
    kind: Type.Literal("delete"),
    path: NormalizedPathSchema,
    expectedBeforeDigest: DigestSchema,
  }),
  closed({
    kind: Type.Literal("delete_directory"),
    path: NormalizedPathSchema,
    expectedTreeDigest: DigestSchema,
    expectedEmptyAtOperation: Type.Literal(true),
  }),
  closed({
    kind: Type.Literal("move"),
    from: NormalizedPathSchema,
    to: NormalizedPathSchema,
    expectedBeforeDigest: DigestSchema,
    expectedDestinationDigest: Type.Union([DigestSchema, Type.Null()]),
  }),
  closed({
    kind: Type.Literal("set_git_mode"),
    path: NormalizedPathSchema,
    expectedBeforeDigest: DigestSchema,
    expectedCurrentMode: FileMode,
    newMode: FileMode,
  }),
  closed({
    kind: Type.Literal("symlink"),
    path: NormalizedPathSchema,
    target: utf8BoundedString(32767),
    expectedBeforeDigest: Type.Union([DigestSchema, Type.Null()]),
    expectedAfterDigest: DigestSchema,
  }),
]);

export const ChangeSetSchema = closed({
  schemaVersion: Type.Literal(1),
  baseSnapshotId: SnapshotIdSchema,
  baseSnapshotRootDigest: DigestSchema,
  operations: Type.Array(ChangeOperationSchema, { minItems: 1 }),
});

export const AssumptionSchema = closed({
  statement: utf8BoundedString(16384),
  evidenceIds: Type.Array(EvidenceIdSchema),
});

export const SolutionRequirementTraceSchema = closed({
  requirementId: RequirementIdSchema,
  satisfaction: Type.Enum(["changed", "already-satisfied"] as const),
  operationIndexes: Type.Array(SafeUintSchema),
  testPaths: Type.Array(NormalizedPathSchema),
  evidenceIds: Type.Array(EvidenceIdSchema),
});

export const NoChangeRequirementTraceSchema = closed({
  requirementId: RequirementIdSchema,
  evidenceIds: Type.Array(EvidenceIdSchema),
});

export const CloudQuestionSchema = closed({
  clientQuestionKey: GeneralIdSchema,
  prompt: utf8BoundedString(16384),
  correctnessImpact: Type.Enum(["blocking", "material"] as const),
  relatedRequirementIds: Type.Array(RequirementIdSchema),
});

export const CloudVerificationProposalSchema = closed({
  kind: Type.Literal("project-command"),
  executable: utf8BoundedString(1024),
  argv: Type.Array(utf8BoundedString(4096)),
  workingDirectory: NormalizedPathSchema,
  relatedRequirementIds: Type.Array(RequirementIdSchema),
  expectedSignal: utf8BoundedString(1024),
});

const SubmittedResultBaseFields = {
  ...CloudResultBindingSchema.properties,
  kind: Type.Literal("submit_solution"),
  summary: Type.String({ minLength: 1, maxLength: 16384 }),
  assumptions: Type.Array(AssumptionSchema, { maxItems: 64 }),
  unresolvedFacts: Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 }),
};

export const SubmittedSolutionSchema = Type.Union([
  Type.Object(
    {
      ...SubmittedResultBaseFields,
      disposition: Type.Literal("solution"),
      changeSet: ChangeSetSchema,
      requirementTrace: Type.Array(SolutionRequirementTraceSchema, { minItems: 1 }),
      verificationProposals: Type.Array(CloudVerificationProposalSchema, { maxItems: 32 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...SubmittedResultBaseFields,
      disposition: Type.Literal("no_change"),
      noChangeEvidenceIds: Type.Array(EvidenceIdSchema, { minItems: 1 }),
      requirementTrace: Type.Array(NoChangeRequirementTraceSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...SubmittedResultBaseFields,
      disposition: Type.Literal("needs_user_input"),
      questions: Type.Array(CloudQuestionSchema, { minItems: 1, maxItems: 16 }),
      blockedRequirementIds: Type.Array(RequirementIdSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const CloudResultSchema = Type.Union([ContextRequestSchema, SubmittedSolutionSchema]);

const CloudToolBindingFields = {
  runId: RunIdSchema,
  cloudCallId: CloudCallIdSchema,
  requestBindingDigest: DomainDigestSchema,
  contextPacketObjectDigest: ObjectDigestSchema,
  baseSnapshotId: SnapshotIdSchema,
  baseSnapshotRootDigest: DomainDigestSchema,
};

export const SubmitSolutionToolParametersSchema = Type.Union([
  Type.Object(
    {
      ...CloudToolBindingFields,
      kind: Type.Literal("submit_solution"),
      summary: Type.String({ minLength: 1, maxLength: 16384 }),
      assumptions: Type.Array(AssumptionSchema, { maxItems: 64 }),
      unresolvedFacts: Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 }),
      disposition: Type.Literal("solution"),
      changeSet: ChangeSetSchema,
      requirementTrace: Type.Array(SolutionRequirementTraceSchema, { minItems: 1 }),
      verificationProposals: Type.Array(CloudVerificationProposalSchema, { maxItems: 32 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CloudToolBindingFields,
      kind: Type.Literal("submit_solution"),
      summary: Type.String({ minLength: 1, maxLength: 16384 }),
      assumptions: Type.Array(AssumptionSchema, { maxItems: 64 }),
      unresolvedFacts: Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 }),
      disposition: Type.Literal("no_change"),
      noChangeEvidenceIds: Type.Array(EvidenceIdSchema, { minItems: 1 }),
      requirementTrace: Type.Array(NoChangeRequirementTraceSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CloudToolBindingFields,
      kind: Type.Literal("submit_solution"),
      summary: Type.String({ minLength: 1, maxLength: 16384 }),
      assumptions: Type.Array(AssumptionSchema, { maxItems: 64 }),
      unresolvedFacts: Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 }),
      disposition: Type.Literal("needs_user_input"),
      questions: Type.Array(CloudQuestionSchema, { minItems: 1, maxItems: 16 }),
      blockedRequirementIds: Type.Array(RequirementIdSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const RequestContextToolParametersSchema = Type.Object(
  {
    ...CloudToolBindingFields,
    kind: Type.Literal("request_context"),
    missingClaimIds: Type.Array(EvidenceIdSchema, { minItems: 1, maxItems: 32 }),
    requestedEvidenceKinds: Type.Array(EvidenceNodeKindSchema, { maxItems: 16 }),
    pathOrSymbolHints: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32 }),
    requestedSkillIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 16 }),
    reason: Type.String({ minLength: 1, maxLength: 16384 }),
  },
  { additionalProperties: false },
);

export const CompiledCloudContentSchema = Type.Union([
  closed({ kind: Type.Literal("text"), text: Type.String({ minLength: 1 }) }),
  closed({
    kind: Type.Literal("artifact"),
    mediaType: utf8BoundedString(256),
    artifactObjectDigest: ObjectDigestSchema,
    canonicalUtf8: Type.String({ minLength: 1 }),
  }),
]);

export const CompiledCloudMessageSchema = Type.Union([
  closed({
    role: Type.Literal("user"),
    content: Type.Array(CompiledCloudContentSchema, { minItems: 1 }),
  }),
  closed({
    role: Type.Literal("assistant"),
    content: Type.Array(CompiledCloudContentSchema),
    terminalCall: Type.Optional(
      closed({
        callId: GeneralIdSchema,
        name: Type.Enum(["submit_solution", "request_context"] as const),
        canonicalArguments: JsonValueSchema,
      }),
    ),
  }),
  closed({
    role: Type.Literal("tool"),
    toolCallId: GeneralIdSchema,
    toolName: Type.Literal("request_context"),
    content: Type.Array(CompiledCloudContentSchema, { minItems: 1 }),
  }),
]);

export const InitialCloudRequestBindingSchema = closed({
  schemaVersion: Type.Literal(1),
  purpose: Type.Literal("initial"),
  runId: RunIdSchema,
  cloudCallId: CloudCallIdSchema,
  contextPacketObjectDigest: ObjectDigestSchema,
  baseSnapshotId: SnapshotIdSchema,
  baseSnapshotRootDigest: DigestSchema,
  deploymentId: ProjectIdSchema,
  adapterVersionObjectDigest: ObjectDigestSchema,
  modelRevision: GeneralIdSchema,
  resultSchemaObjectDigest: ObjectDigestSchema,
});

export const ContextFollowupCloudRequestBindingSchema = closed({
  schemaVersion: Type.Literal(1),
  purpose: Type.Literal("context-followup"),
  runId: RunIdSchema,
  cloudCallId: CloudCallIdSchema,
  parentCloudCallId: CloudCallIdSchema,
  contextPacketObjectDigest: ObjectDigestSchema,
  contextDeltaObjectDigest: ObjectDigestSchema,
  baseSnapshotId: SnapshotIdSchema,
  baseSnapshotRootDigest: DigestSchema,
  deploymentId: ProjectIdSchema,
  adapterVersionObjectDigest: ObjectDigestSchema,
  modelRevision: GeneralIdSchema,
  resultSchemaObjectDigest: ObjectDigestSchema,
});

export const RepairCloudRequestBindingSchema = closed({
  schemaVersion: Type.Literal(1),
  purpose: Type.Literal("repair"),
  runId: RunIdSchema,
  cloudCallId: CloudCallIdSchema,
  parentCloudCallId: CloudCallIdSchema,
  contextPacketObjectDigest: ObjectDigestSchema,
  repairPacketObjectDigest: ObjectDigestSchema,
  priorCandidateManifestObjectDigest: ObjectDigestSchema,
  baseSnapshotId: SnapshotIdSchema,
  baseSnapshotRootDigest: DigestSchema,
  deploymentId: ProjectIdSchema,
  adapterVersionObjectDigest: ObjectDigestSchema,
  modelRevision: GeneralIdSchema,
  resultSchemaObjectDigest: ObjectDigestSchema,
});

export const CloudRequestBindingSchema = Type.Union([
  InitialCloudRequestBindingSchema,
  ContextFollowupCloudRequestBindingSchema,
  RepairCloudRequestBindingSchema,
]);

export const CompiledCloudConversationSchema = closed({
  schemaVersion: Type.Literal(1),
  requestBinding: CloudRequestBindingSchema,
  requestBindingDigest: DomainDigestSchema,
  systemPrompt: Type.String({ minLength: 1 }),
  messages: Type.Array(CompiledCloudMessageSchema),
  tools: Type.Array(
    closed({
      name: Type.Enum(["submit_solution", "request_context"] as const),
      description: utf8BoundedString(16384),
      inputSchema: JsonValueSchema,
      inputSchemaObjectDigest: ObjectDigestSchema,
    }),
  ),
  allowedTerminalTools: Type.Tuple([
    Type.Literal("submit_solution"),
    Type.Literal("request_context"),
  ]),
  exactlyOneTerminalCallRequired: Type.Literal(true),
});

const CanonicalCloudRequestBaseFields = {
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  cloudCallId: CloudCallIdSchema,
  requestBindingDigest: DomainDigestSchema,
  deploymentId: ProjectIdSchema,
  adapterVersionObjectDigest: ObjectDigestSchema,
  contextPacketObjectDigest: ObjectDigestSchema,
  egressManifestObjectDigest: ObjectDigestSchema,
  compiledConversationObjectDigest: ObjectDigestSchema,
  resultMode: Type.Enum(["terminal-tools", "strict-json-schema"] as const),
  maxOutputTokens: SafeUintSchema,
  reasoningProfile: utf8BoundedString(256),
};

function cloudRequestFieldsMatch(value: {
  purpose: "initial" | "context-followup" | "repair";
  runId: string;
  cloudCallId: string;
  deploymentId: string;
  adapterVersionObjectDigest: string;
  contextPacketObjectDigest: string;
  requestBinding: {
    purpose: string;
    runId: string;
    cloudCallId: string;
    deploymentId: string;
    adapterVersionObjectDigest: string;
    contextPacketObjectDigest: string;
    parentCloudCallId?: string;
    contextDeltaObjectDigest?: string;
    repairPacketObjectDigest?: string;
    priorCandidateManifestObjectDigest?: string;
  };
  parentCloudCallId?: string;
  contextDeltaObjectDigest?: string;
  repairPacketObjectDigest?: string;
  priorCandidateManifestObjectDigest?: string;
}): boolean {
  const binding = value.requestBinding;
  if (
    binding.purpose !== value.purpose ||
    binding.runId !== value.runId ||
    binding.cloudCallId !== value.cloudCallId ||
    binding.deploymentId !== value.deploymentId ||
    binding.adapterVersionObjectDigest !== value.adapterVersionObjectDigest ||
    binding.contextPacketObjectDigest !== value.contextPacketObjectDigest
  ) {
    return false;
  }
  if (value.purpose === "initial") {
    return true;
  }
  if (value.purpose === "context-followup") {
    return (
      binding.parentCloudCallId === value.parentCloudCallId &&
      binding.contextDeltaObjectDigest === value.contextDeltaObjectDigest
    );
  }
  return (
    binding.parentCloudCallId === value.parentCloudCallId &&
    binding.repairPacketObjectDigest === value.repairPacketObjectDigest &&
    binding.priorCandidateManifestObjectDigest === value.priorCandidateManifestObjectDigest
  );
}

export const CanonicalCloudRequestSchema = Type.Union([
  Type.Refine(
    closed({
      ...CanonicalCloudRequestBaseFields,
      purpose: Type.Literal("initial"),
      requestBinding: InitialCloudRequestBindingSchema,
    }),
    cloudRequestFieldsMatch,
    () => "CanonicalCloudRequest purpose fields must be byte-equivalent to requestBinding",
  ),
  Type.Refine(
    closed({
      ...CanonicalCloudRequestBaseFields,
      purpose: Type.Literal("context-followup"),
      parentCloudCallId: CloudCallIdSchema,
      contextDeltaObjectDigest: ObjectDigestSchema,
      requestBinding: ContextFollowupCloudRequestBindingSchema,
    }),
    cloudRequestFieldsMatch,
    () => "CanonicalCloudRequest purpose fields must be byte-equivalent to requestBinding",
  ),
  Type.Refine(
    closed({
      ...CanonicalCloudRequestBaseFields,
      purpose: Type.Literal("repair"),
      parentCloudCallId: CloudCallIdSchema,
      repairPacketObjectDigest: ObjectDigestSchema,
      priorCandidateManifestObjectDigest: ObjectDigestSchema,
      requestBinding: RepairCloudRequestBindingSchema,
    }),
    cloudRequestFieldsMatch,
    () => "CanonicalCloudRequest purpose fields must be byte-equivalent to requestBinding",
  ),
]);

export const ProviderWireRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  requestEnvelopeObjectDigest: ObjectDigestSchema,
  deploymentId: ProjectIdSchema,
  adapterVersionObjectDigest: ObjectDigestSchema,
  endpointIdentity: utf8BoundedString(1024),
  providerApiVersion: utf8BoundedString(64),
  modelRevision: GeneralIdSchema,
  method: Type.Literal("POST"),
  nonSecretHeaders: Type.Array(
    closed({ nameLowercase: utf8BoundedString(256), value: utf8BoundedString(4096) }),
  ),
  bodyMediaType: Type.Literal("application/json"),
  bodyObjectDigest: ObjectDigestSchema,
  bodyByteSize: SafeUintSchema,
  providerIdempotencyKey: utf8BoundedString(256),
});

export const NormalizedUsageSchema = closed({
  inputTokens: Type.Union([SafeUintSchema, Type.Null()]),
  outputTokens: Type.Union([SafeUintSchema, Type.Null()]),
  reasoningTokens: Type.Union([SafeUintSchema, Type.Null()]),
  cachedInputTokens: Type.Union([SafeUintSchema, Type.Null()]),
  cacheWriteTokens: Type.Union([SafeUintSchema, Type.Null()]),
  totalTokens: Type.Union([SafeUintSchema, Type.Null()]),
  providerReported: Type.Boolean(),
  complete: Type.Boolean(),
  estimatedCost: Type.Union([
    closed({
      currency: Type.String({ minLength: 3, maxLength: 8 }),
      decimalAmount: MoneySchema,
      pricingSnapshotObjectDigest: ObjectDigestSchema,
    }),
    Type.Null(),
  ]),
});

const CloudCompletionReceiptBaseFields = {
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  cloudCallId: CloudCallIdSchema,
  requestEnvelopeObjectDigest: ObjectDigestSchema,
  providerWireRequestObjectDigest: ObjectDigestSchema,
  providerWireRequestDigest: DomainDigestSchema,
  deploymentId: ProjectIdSchema,
  providerRequestId: Type.Optional(utf8BoundedString(256)),
  providerOperationId: Type.Optional(utf8BoundedString(256)),
  completedAt: TimestampSchema,
  usage: NormalizedUsageSchema,
};

export const CloudCompletionReceiptFailedNotAcceptedSchema = Type.Object(
  {
    ...CloudCompletionReceiptBaseFields,
    outcome: Type.Literal("FAILED"),
    acceptedness: Type.Literal("PROVEN_NOT_ACCEPTED"),
    finishReason: Type.Literal("error"),
    transportEvidenceObjectDigest: ObjectDigestSchema,
    error: closed({
      code: GeneralIdSchema,
      retryClass: Type.Literal("SAFE_SAME_REQUEST"),
      message: ReasonSchema,
    }),
  },
  { additionalProperties: false },
);

export const CloudCompletionReceiptSchema = Type.Union([
  Type.Object(
    {
      ...CloudCompletionReceiptBaseFields,
      outcome: Type.Literal("VALID_RESULT"),
      acceptedAt: TimestampSchema,
      finishReason: Type.Enum(["tool_calls", "stop"] as const),
      rawResponseArtifactObjectDigest: ObjectDigestSchema,
      result: CloudResultSchema,
      resultObjectDigest: ObjectDigestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CloudCompletionReceiptBaseFields,
      outcome: Type.Literal("INCOMPLETE"),
      acceptedAt: TimestampSchema,
      finishReason: Type.Enum(["length", "cancelled"] as const),
      incidentRecordObjectDigest: ObjectDigestSchema,
      error: closed({
        code: GeneralIdSchema,
        retryClass: Type.Enum(["RECONCILE_FIRST", "DO_NOT_RETRY"] as const),
        message: ReasonSchema,
      }),
    },
    { additionalProperties: false },
  ),
  CloudCompletionReceiptFailedNotAcceptedSchema,
  Type.Object(
    {
      ...CloudCompletionReceiptBaseFields,
      outcome: Type.Literal("FAILED"),
      acceptedness: Type.Literal("ACCEPTED"),
      acceptedAt: TimestampSchema,
      finishReason: Type.Literal("error"),
      incidentRecordObjectDigest: ObjectDigestSchema,
      error: closed({
        code: GeneralIdSchema,
        retryClass: Type.Enum(["RECONCILE_FIRST", "DO_NOT_RETRY"] as const),
        message: ReasonSchema,
      }),
    },
    { additionalProperties: false },
  ),
]);

export const EgressManifestSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  snapshotId: SnapshotIdSchema,
  contextPacketObjectDigest: ObjectDigestSchema,
  deploymentId: ProjectIdSchema,
  adapterVersionObjectDigest: ObjectDigestSchema,
  endpointIdentity: utf8BoundedString(1024),
  providerChain: Type.Array(utf8BoundedString(256)),
  modelRevision: GeneralIdSchema,
  region: Type.Optional(utf8BoundedString(64)),
  retentionPolicyObjectDigest: ObjectDigestSchema,
  classification: Type.Enum(["public", "internal", "confidential"] as const),
  sourceRefs: Type.Array(SourceRefSchema),
  redactions: Type.Array(
    closed({
      marker: utf8BoundedString(256),
      findingType: utf8BoundedString(256),
      sourceRef: SourceRefSchema,
    }),
  ),
  scannerVersions: Type.Array(utf8BoundedString(256)),
  compiledConversationObjectDigest: ObjectDigestSchema,
  expiresAt: TimestampSchema,
});

export const CloudDispatchSchema = closed({
  request: ArtifactEnvelopeSchema(CanonicalCloudRequestSchema),
  egress: ArtifactEnvelopeSchema(EgressManifestSchema),
  conversation: ArtifactEnvelopeSchema(CompiledCloudConversationSchema),
  wireRequest: ArtifactEnvelopeSchema(ProviderWireRequestSchema),
});

export const CloudRecoveryLookupKeySchema = Type.Union([
  closed({ kind: Type.Literal("request-object"), requestEnvelopeObjectDigest: ObjectDigestSchema }),
  closed({ kind: Type.Literal("provider-idempotency-key"), value: utf8BoundedString(256) }),
  closed({ kind: Type.Literal("provider-operation-id"), value: utf8BoundedString(256) }),
]);

export const CloudRecoveryLookupResultSchema = Type.Union([
  closed({ state: Type.Literal("completed"), receipt: CloudCompletionReceiptSchema }),
  closed({ state: Type.Literal("pending"), retryAfterMs: Type.Optional(SafeUintSchema) }),
  closed({ state: Type.Literal("missing") }),
  closed({ state: Type.Literal("unknown"), reasonCode: GeneralIdSchema }),
]);

export const CapabilitySupportSchema = Type.Enum([
  "native",
  "emulated",
  "unsupported",
  "unknown",
] as const);

export const DeploymentCapabilitiesSchema = closed({
  deploymentId: ProjectIdSchema,
  adapterVersionObjectDigest: ObjectDigestSchema,
  providerApiVersion: utf8BoundedString(64),
  modelRevision: GeneralIdSchema,
  context: closed({
    nativeTokens: SafeUintSchema,
    extendedTokens: Type.Union([SafeUintSchema, Type.Null()]),
    maxOutputTokens: Type.Union([SafeUintSchema, Type.Null()]),
  }),
  thinking: closed({
    supported: CapabilitySupportSchema,
    required: Type.Boolean(),
    efforts: Type.Array(utf8BoundedString(64)),
    preservesAcrossToolTurns: Type.Boolean(),
  }),
  structuredOutput: closed({
    jsonSchema: CapabilitySupportSchema,
    strict: CapabilitySupportSchema,
    schemaDialect: Type.Union([utf8BoundedString(256), Type.Null()]),
  }),
  tools: closed({
    supported: CapabilitySupportSchema,
    requiredChoice: CapabilitySupportSchema,
    parallelCallsCanBeDisabled: Type.Boolean(),
    namedChoiceWithThinking: CapabilitySupportSchema,
  }),
  caching: closed({
    mode: Type.Enum(["none", "automatic-prefix", "explicit-breakpoint"] as const),
    reportsReadTokens: Type.Boolean(),
    reportsWriteTokens: Type.Boolean(),
  }),
  recovery: Type.Union([
    closed({
      grade: Type.Literal("A"),
      idempotencyKey: Type.Literal(true),
      resultLookup: Type.Literal(true),
      lookupKeyKinds: Type.Array(
        Type.Enum(["request-object", "provider-idempotency-key"] as const),
        { minItems: 1 },
      ),
      serverCancellation: Type.Boolean(),
    }),
    closed({
      grade: Type.Literal("B"),
      idempotencyKey: Type.Boolean(),
      resultLookup: Type.Literal(true),
      lookupKeyKinds: Type.Tuple([Type.Literal("provider-operation-id")]),
      serverCancellation: Type.Boolean(),
    }),
    closed({
      grade: Type.Literal("C"),
      idempotencyKey: Type.Literal(false),
      resultLookup: Type.Literal(false),
      lookupKeyKinds: Type.Tuple([]),
      serverCancellation: Type.Literal(false),
    }),
  ]),
  evidence: Type.Array(
    closed({
      source: utf8BoundedString(256),
      checkedAt: TimestampSchema,
      adapterVersion: utf8BoundedString(256),
      conformanceResultObjectDigest: ObjectDigestSchema,
    }),
  ),
});

export const CloudDispatchResultSchema = Type.Union([
  closed({ state: Type.Literal("completed"), receipt: CloudCompletionReceiptSchema }),
  closed({
    state: Type.Literal("not-dispatched"),
    reasonCode: GeneralIdSchema,
    receipt: CloudCompletionReceiptFailedNotAcceptedSchema,
  }),
  closed({
    state: Type.Literal("accepted-outcome-unknown"),
    availableLookupKeys: Type.Array(CloudRecoveryLookupKeySchema),
    transportEvidenceObjectDigest: ObjectDigestSchema,
  }),
]);

export type CloudResult = Static<typeof CloudResultSchema>;
export type ChangeOperation = Static<typeof ChangeOperationSchema>;
export type ChangeSet = Static<typeof ChangeSetSchema>;
export type ContextRequest = Static<typeof ContextRequestSchema>;
export type SubmittedSolution = Static<typeof SubmittedSolutionSchema>;
export type CanonicalCloudRequest = Static<typeof CanonicalCloudRequestSchema>;
export type CloudCompletionReceipt = Static<typeof CloudCompletionReceiptSchema>;
export type EgressManifest = Static<typeof EgressManifestSchema>;
export type ProviderWireRequest = Static<typeof ProviderWireRequestSchema>;
export type NormalizedUsage = Static<typeof NormalizedUsageSchema>;
export type DeploymentCapabilities = Static<typeof DeploymentCapabilitiesSchema>;
export type CloudRequestBinding = Static<typeof CloudRequestBindingSchema>;
export type CompiledCloudConversation = Static<typeof CompiledCloudConversationSchema>;
export type CloudRecoveryLookupKey = Static<typeof CloudRecoveryLookupKeySchema>;
export type CloudRecoveryLookupResult = Static<typeof CloudRecoveryLookupResultSchema>;
export type CloudDispatchResult = Static<typeof CloudDispatchResultSchema>;
export type CloudDispatch = Static<typeof CloudDispatchSchema>;
