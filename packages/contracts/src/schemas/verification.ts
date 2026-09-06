import { Type, type Static } from "typebox";
import {
  CandidateIdSchema,
  CheckIdSchema,
  ConfidenceSchema,
  DigestSchema,
  EvidenceIdSchema,
  GeneralIdSchema,
  ObjectDigestSchema,
  ObligationIdSchema,
  RequirementIdSchema,
  RunIdSchema,
  SafeUintSchema,
  SnapshotIdSchema,
  TimestampSchema,
  closed,
  utf8BoundedString,
} from "../ids.js";
import {
  SourceRangeSchema,
  CommandSpecSchema,
  EnvelopeBytesContentSchema,
  SourceRefSchema,
} from "./artifacts.js";
import {
  EvidenceNodeKindSchema,
  EvidenceNodeSchema,
  EvidenceEdgeSchema,
  EvidenceRelationSchema,
  RequirementSchema,
} from "./run.js";

export const VerdictSchema = Type.Enum(["ACCEPTED", "REJECTED", "INCONCLUSIVE"] as const);
export const ObligationStatusSchema = Type.Enum(["PASS", "FAIL", "UNKNOWN"] as const);

export const ProofObligationSchema = closed({
  id: ObligationIdSchema,
  requirementIds: Type.Array(RequirementIdSchema),
  claim: utf8BoundedString(16384),
  claimMode: Type.Enum(["UNIVERSAL", "EXISTENTIAL", "INVARIANT", "NON_REGRESSION"] as const),
  kind: Type.Enum([
    "FUNCTIONAL",
    "BUILD",
    "STATIC_ANALYSIS",
    "REPRODUCTION",
    "SECURITY",
    "PERFORMANCE",
    "SOURCE_COMPATIBILITY",
    "WIRE_COMPATIBILITY",
    "ABI_COMPATIBILITY",
    "SCHEMA_COMPATIBILITY",
    "DATA_MIGRATION",
    "VISUAL",
    "ACCESSIBILITY",
    "BROWSER_INTERACTION",
    "MOBILE_LIFECYCLE",
    "PLATFORM_MATRIX",
    "EVIDENCE_INTEGRITY",
  ] as const),
  mandatory: Type.Boolean(),
  sourceRefs: Type.Array(SourceRefSchema),
  prerequisites: Type.Array(ObligationIdSchema),
});

export const RunObservationSchema = closed({
  attempt: SafeUintSchema,
  seed: Type.Optional(utf8BoundedString(256)),
  state: Type.Enum(["PASSED", "FAILED", "ERROR", "SKIPPED"] as const),
  observationSignature: Type.Optional(DigestSchema),
  exitCode: Type.Optional(Type.Integer({ minimum: -2147483648, maximum: 2147483647 })),
  durationMs: SafeUintSchema,
  stdoutArtifact: Type.Optional(ObjectDigestSchema),
  stderrArtifact: Type.Optional(ObjectDigestSchema),
});

export const EvidenceRecordSchema = closed({
  schemaVersion: Type.Literal(1),
  id: GeneralIdSchema,
  obligationId: ObligationIdSchema,
  relation: Type.Enum(["SUPPORTS", "REFUTES", "NEUTRAL"] as const),
  origin: Type.Enum([
    "VERIFIER",
    "USER",
    "SEALED_PROJECT",
    "INDEPENDENT_TOOL",
    "CANDIDATE_TEST",
    "LOCAL_MODEL",
    "CLOUD_CLAIM",
  ] as const),
  independenceGroup: GeneralIdSchema,
  oracle: Type.Enum([
    "EXPLICIT_EXPECTATION",
    "RED_GREEN",
    "REGRESSION",
    "PROPERTY",
    "METAMORPHIC",
    "DIFFERENTIAL",
    "MUTATION",
    "SCHEMA_DIFF",
    "ABI_DIFF",
    "VISUAL_REFERENCE",
    "HUMAN_AUTHORIZED",
  ] as const),
  baselineSealObjectDigest: ObjectDigestSchema,
  subject: Type.Union([
    closed({
      kind: Type.Literal("BASELINE"),
      snapshotId: SnapshotIdSchema,
      snapshotRootDigest: DigestSchema,
    }),
    closed({
      kind: Type.Literal("CANDIDATE"),
      candidateManifestObjectDigest: ObjectDigestSchema,
    }),
  ]),
  producerId: GeneralIdSchema,
  producerVersionObjectDigest: ObjectDigestSchema,
  environmentSealObjectDigest: ObjectDigestSchema,
  observations: Type.Array(RunObservationSchema),
  artifactObjectDigests: Type.Array(ObjectDigestSchema),
});

export const EvidenceAssessmentSchema = Type.Union([
  closed({
    evidenceId: GeneralIdSchema,
    state: Type.Literal("ADMISSIBLE"),
    policyRevisionObjectDigest: ObjectDigestSchema,
  }),
  closed({
    evidenceId: GeneralIdSchema,
    state: Type.Literal("INADMISSIBLE"),
    policyRevisionObjectDigest: ObjectDigestSchema,
    reasons: Type.Array(utf8BoundedString(1024), { minItems: 1 }),
  }),
]);

export const VerdictReportSchema = closed({
  schemaVersion: Type.Literal(1),
  verdict: VerdictSchema,
  baselineSealObjectDigest: ObjectDigestSchema,
  subject: Type.Union([
    closed({
      kind: Type.Literal("CHANGESET"),
      candidateManifestObjectDigest: ObjectDigestSchema,
    }),
    closed({
      kind: Type.Literal("BASELINE_NO_CHANGE"),
      snapshotId: SnapshotIdSchema,
      snapshotRootDigest: DigestSchema,
    }),
  ]),
  verificationPlanObjectDigest: ObjectDigestSchema,
  obligationResults: Type.Array(
    closed({
      obligationId: ObligationIdSchema,
      status: ObligationStatusSchema,
      evidenceIds: Type.Array(GeneralIdSchema),
      reason: utf8BoundedString(16384),
    }),
  ),
  failures: Type.Array(
    closed({
      code: GeneralIdSchema,
      attribution: Type.Enum([
        "CANDIDATE",
        "BASELINE",
        "ENVIRONMENT",
        "REQUIREMENT",
        "VERIFIER",
        "UNKNOWN",
      ] as const),
      repairOwner: Type.Enum(["CLOUD", "USER", "ENVIRONMENT", "VERIFIER", "NONE"] as const),
      certainty: Type.Enum(["CONFIRMED", "PROBABLE", "UNRESOLVED"] as const),
      obligationIds: Type.Array(ObligationIdSchema),
      evidenceIds: Type.Array(GeneralIdSchema),
      failureSignature: DigestSchema,
      summary: utf8BoundedString(16384),
    }),
  ),
  evidenceRootDigest: DigestSchema,
  evidenceAssessments: Type.Array(EvidenceAssessmentSchema),
  workflowState: Type.Enum([
    "TERMINAL",
    "REPAIRABLE",
    "WAITING_USER",
    "WAITING_ENVIRONMENT",
    "WAITING_PROVIDER",
    "NO_PROGRESS",
  ] as const),
});

export const EnvironmentSealSchema = closed({
  schemaVersion: Type.Literal(1),
  imageObjectDigest: Type.Optional(ObjectDigestSchema),
  os: utf8BoundedString(128),
  architecture: utf8BoundedString(64),
  kernel: Type.Optional(utf8BoundedString(128)),
  toolchains: Type.Record(Type.String(), Type.String()),
  dependencyLockObjectDigests: Type.Array(ObjectDigestSchema),
  locale: utf8BoundedString(64),
  timezone: utf8BoundedString(64),
  fontObjectDigests: Type.Array(ObjectDigestSchema),
  browserBuildObjectDigests: Type.Array(ObjectDigestSchema),
  deviceProfileObjectDigests: Type.Array(ObjectDigestSchema),
  secretHandles: Type.Array(GeneralIdSchema),
  externalParameters: Type.Record(Type.String(), Type.String()),
});

export const BaselineSealSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  taskEnvelopeObjectDigest: ObjectDigestSchema,
  snapshotId: SnapshotIdSchema,
  snapshotRootDigest: DigestSchema,
  instructionManifestObjectDigest: ObjectDigestSchema,
  skillManifestObjectDigest: ObjectDigestSchema,
  environmentSealObjectDigest: ObjectDigestSchema,
  commandPlanObjectDigest: ObjectDigestSchema,
  baselineEvidenceRootDigest: DigestSchema,
  exclusionManifestObjectDigest: ObjectDigestSchema,
  verifierManifestObjectDigest: ObjectDigestSchema,
  createdAt: TimestampSchema,
});

export const BaselineSupplementSchema = closed({
  schemaVersion: Type.Literal(1),
  baselineSealObjectDigest: ObjectDigestSchema,
  verificationPlanRevision: SafeUintSchema,
  environmentSealObjectDigest: ObjectDigestSchema,
  observationArtifactObjectDigests: Type.Array(ObjectDigestSchema),
  reason: Type.Literal("CANDIDATE_DISCOVERED_PAIRED_CHECK"),
  createdAt: TimestampSchema,
});

export const CheckNodeSchema = closed({
  id: CheckIdSchema,
  obligationIds: Type.Array(ObligationIdSchema),
  subject: Type.Enum(["BASELINE", "CANDIDATE", "PAIRED"] as const),
  recipe: Type.Union([
    CommandSpecSchema,
    closed({
      intrinsicCheckId: GeneralIdSchema,
      configurationObjectDigest: ObjectDigestSchema,
    }),
  ]),
  dependencies: Type.Array(CheckIdSchema),
  mandatory: Type.Boolean(),
  approval: Type.Enum(["AUTO", "REQUIRE_USER", "DENY"] as const),
});

export const VerificationPlanSchema = closed({
  schemaVersion: Type.Literal(1),
  planId: GeneralIdSchema,
  revision: SafeUintSchema,
  baselineSealObjectDigest: ObjectDigestSchema,
  requirements: Type.Array(RequirementSchema),
  obligations: Type.Array(ProofObligationSchema),
  checks: Type.Array(CheckNodeSchema),
  baselineSupplementObjectDigests: Type.Array(ObjectDigestSchema),
  previousPlanObjectDigest: Type.Optional(ObjectDigestSchema),
});

export const RepairPacketSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  baseSnapshotId: SnapshotIdSchema,
  baselineSealObjectDigest: ObjectDigestSchema,
  priorCandidateId: CandidateIdSchema,
  priorCandidateManifestObjectDigest: ObjectDigestSchema,
  unresolvedObligationIds: Type.Array(ObligationIdSchema),
  failureClusters: Type.Array(
    closed({
      primaryFailureSignature: DigestSchema,
      secondaryFailureSignatures: Type.Array(DigestSchema),
      baselineEvidenceIds: Type.Array(GeneralIdSchema),
      relevantSourceRefs: Type.Array(SourceRefSchema),
      minimalReproducerArtifactObjectDigest: Type.Optional(ObjectDigestSchema),
    }),
  ),
  preservedPassingObligationIds: Type.Array(ObligationIdSchema),
  prohibitedRegressionObligationIds: Type.Array(ObligationIdSchema),
  inlineFailureArtifacts: Type.Array(
    closed({
      objectDigest: ObjectDigestSchema,
      mediaType: utf8BoundedString(256),
      sourceRefs: Type.Array(SourceRefSchema),
      content: EnvelopeBytesContentSchema,
    }),
  ),
  fullEvidenceRootDigest: DigestSchema,
  requiredResponse: Type.Literal("FULL_REPLACEMENT_CHANGESET"),
});

export const RetrievalActionSchema = closed({
  id: GeneralIdSchema,
  channelId: GeneralIdSchema,
  targetClaimIds: Type.Array(EvidenceIdSchema),
  query: utf8BoundedString(4096),
  filters: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
  expectedInformationGain: ConfidenceSchema,
  expectedTrustGain: ConfidenceSchema,
  estimatedLatencyMs: SafeUintSchema,
  estimatedPacketTokens: SafeUintSchema,
});

export const RetrievalActionProposalSchema = RetrievalActionSchema;

export const LocalEvidenceProposalSchema = closed({
  proposalId: GeneralIdSchema,
  kind: Type.Enum(["hypothesis", "risk", "unknown", "conflict"] as const),
  statement: utf8BoundedString(16384),
  citedSourceRefs: Type.Array(SourceRefSchema),
  targetClaimIds: Type.Array(EvidenceIdSchema),
  requestedReproductionActions: Type.Array(RetrievalActionSchema),
});

export const UnknownClaimProposalSchema = LocalEvidenceProposalSchema;
export const ConflictProposalSchema = LocalEvidenceProposalSchema;

export const LocalRelationProposalSchema = closed({
  proposalId: GeneralIdSchema,
  fromCandidateRef: Type.Union([EvidenceIdSchema, GeneralIdSchema]),
  toCandidateRef: Type.Union([EvidenceIdSchema, GeneralIdSchema]),
  relation: EvidenceRelationSchema,
  citedSourceRefs: Type.Array(SourceRefSchema),
});

export const RetrievalQueryRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  snapshotId: SnapshotIdSchema,
  originalRequest: utf8BoundedString(262144),
  unresolvedClaimIds: Type.Array(EvidenceIdSchema),
  existingQueries: Type.Array(utf8BoundedString(4096)),
});

export const RetrievalQueryResultSchema = closed({
  schemaVersion: Type.Literal(1),
  queries: Type.Array(
    closed({
      query: utf8BoundedString(4096),
      targetClaimIds: Type.Array(EvidenceIdSchema),
      entityHints: Type.Array(utf8BoundedString(1024)),
      relationHints: Type.Array(EvidenceRelationSchema),
    }),
  ),
});

export const EvidenceFrontierRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  snapshotId: SnapshotIdSchema,
  evidenceGraphObjectDigest: ObjectDigestSchema,
  lane: Type.Enum([
    "requirements",
    "structure",
    "runtime-tests",
    "history",
    "instructions",
    "risk",
    "counter-evidence",
  ] as const),
  unresolvedClaimIds: Type.Array(EvidenceIdSchema),
  availableChannelIds: Type.Array(GeneralIdSchema),
  visitedActionDigests: Type.Array(DigestSchema),
});

export const EvidenceActionProposalSchema = closed({
  schemaVersion: Type.Literal(1),
  evidenceGraphObjectDigest: ObjectDigestSchema,
  actions: Type.Array(RetrievalActionSchema),
  fixedPointClaimed: Type.Boolean(),
});

export const EvidenceLinkRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  snapshotId: SnapshotIdSchema,
  evidenceGraphObjectDigest: ObjectDigestSchema,
  nodeIds: Type.Array(EvidenceIdSchema),
  allowedRelations: Type.Array(EvidenceRelationSchema),
});

export const EvidenceLinkResultSchema = closed({
  schemaVersion: Type.Literal(1),
  evidenceGraphObjectDigest: ObjectDigestSchema,
  proposedEvidence: Type.Array(LocalEvidenceProposalSchema),
  proposedRelations: Type.Array(LocalRelationProposalSchema),
});

export const EpistemicAuditRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  evidenceGraphObjectDigest: ObjectDigestSchema,
  requirementIds: Type.Array(RequirementIdSchema),
  closureTemplate: Type.Enum(["bug", "feature", "refactor", "investigation"] as const),
});

export const EpistemicAuditResultSchema = closed({
  schemaVersion: Type.Literal(1),
  evidenceGraphObjectDigest: ObjectDigestSchema,
  proposedUnknowns: Type.Array(LocalEvidenceProposalSchema),
  proposedConflicts: Type.Array(LocalEvidenceProposalSchema),
  closureCheckSuggestions: Type.Array(
    closed({
      id: GeneralIdSchema,
      relevantEvidenceIds: Type.Array(EvidenceIdSchema),
      missingEvidenceKinds: Type.Array(EvidenceNodeKindSchema),
    }),
  ),
});

export const LocalSemanticFindingSchema = closed({
  id: GeneralIdSchema,
  kind: Type.Enum([
    "AMBIGUITY",
    "CONTRADICTION",
    "RISK",
    "ROOT_CAUSE_HYPOTHESIS",
    "SEMANTIC_MISMATCH",
    "MISSING_EVIDENCE",
  ] as const),
  statement: utf8BoundedString(16384),
  sourceRefs: Type.Array(SourceRefSchema),
  requirementIds: Type.Array(RequirementIdSchema),
  confidence: Type.Enum(["LOW", "MEDIUM", "HIGH"] as const),
});

export const SemanticVerificationRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  snapshotId: SnapshotIdSchema,
  requirementLedgerObjectDigest: ObjectDigestSchema,
  candidateId: CandidateIdSchema,
  candidateManifestObjectDigest: ObjectDigestSchema,
  changeSetObjectDigest: ObjectDigestSchema,
  evidenceGraphObjectDigest: ObjectDigestSchema,
  deterministicEvidenceIds: Type.Array(GeneralIdSchema),
});

export const SemanticVerificationResultSchema = closed({
  schemaVersion: Type.Literal(1),
  candidateId: CandidateIdSchema,
  candidateManifestObjectDigest: ObjectDigestSchema,
  findings: Type.Array(LocalSemanticFindingSchema),
});

export const RetrievalIntentSchema = closed({
  runId: RunIdSchema,
  snapshotId: SnapshotIdSchema,
  claimIds: Type.Array(EvidenceIdSchema),
  entityHints: Type.Array(utf8BoundedString(1024)),
  relationHints: Type.Array(EvidenceRelationSchema),
});

export const EvidenceDeltaSchema = closed({
  schemaVersion: Type.Literal(1),
  baseEvidenceGraphObjectDigest: ObjectDigestSchema,
  nodes: Type.Array(EvidenceNodeSchema),
  edges: Type.Array(EvidenceEdgeSchema),
  unresolvedClaimIds: Type.Array(EvidenceIdSchema),
  nextActions: Type.Array(RetrievalActionSchema),
});

export const SnapshotBoundToolBase = {
  snapshotId: SnapshotIdSchema,
};

export const EvidenceSearchParametersSchema = closed({
  ...SnapshotBoundToolBase,
  query: utf8BoundedString(4096),
  channelId: Type.Enum(["lexical", "structural", "history", "tests", "instructions"] as const),
  targetClaimIds: Type.Array(EvidenceIdSchema, { maxItems: 32 }),
  pathPrefix: Type.Optional(utf8BoundedString(32767)),
  limit: Type.Integer({ minimum: 1, maximum: 50 }),
});

export const EvidenceReadSourceParametersSchema = closed({
  ...SnapshotBoundToolBase,
  path: utf8BoundedString(32767),
  range: SourceRangeSchema,
});

export const EvidenceExpandSymbolParametersSchema = closed({
  ...SnapshotBoundToolBase,
  path: utf8BoundedString(32767),
  symbolName: utf8BoundedString(1024),
  relation: Type.Enum([
    "definition",
    "references",
    "callers",
    "callees",
    "implementations",
    "type",
  ] as const),
});

export const EvidenceGetRelationsParametersSchema = closed({
  ...SnapshotBoundToolBase,
  evidenceId: EvidenceIdSchema,
  edgeKinds: Type.Array(EvidenceRelationSchema, { minItems: 1, maxItems: 16 }),
});

export const EvidenceGetTestObservationsParametersSchema = closed({
  ...SnapshotBoundToolBase,
  checkId: CheckIdSchema,
});

export const EvidenceGetGitHistoryParametersSchema = closed({
  ...SnapshotBoundToolBase,
  path: utf8BoundedString(32767),
  maxCommits: Type.Integer({ minimum: 1, maximum: 50 }),
});

export const EvidenceGetInstructionScopeParametersSchema = closed({
  ...SnapshotBoundToolBase,
  path: utf8BoundedString(32767),
});

export const EvidenceSubmitActionsParametersSchema = closed({
  ...SnapshotBoundToolBase,
  actions: Type.Array(RetrievalActionProposalSchema, { minItems: 1, maxItems: 16 }),
});

export const EvidenceSubmitAuditParametersSchema = closed({
  ...SnapshotBoundToolBase,
  unknowns: Type.Array(UnknownClaimProposalSchema, { maxItems: 32 }),
  conflicts: Type.Array(ConflictProposalSchema, { maxItems: 32 }),
  saturationReasons: Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 }),
});

export const evidenceToolNames = [
  "evidence_search",
  "evidence_read_source",
  "evidence_expand_symbol",
  "evidence_get_relations",
  "evidence_get_test_observations",
  "evidence_get_git_history",
  "evidence_get_instruction_scope",
  "evidence_submit_actions",
  "evidence_submit_audit",
] as const;

export type Verdict = Static<typeof VerdictSchema>;
export type ObligationStatus = Static<typeof ObligationStatusSchema>;
export type ProofObligation = Static<typeof ProofObligationSchema>;
export type EvidenceRecord = Static<typeof EvidenceRecordSchema>;
export type VerdictReport = Static<typeof VerdictReportSchema>;
export type EnvironmentSeal = Static<typeof EnvironmentSealSchema>;
export type BaselineSeal = Static<typeof BaselineSealSchema>;
export type BaselineSupplement = Static<typeof BaselineSupplementSchema>;
export type VerificationPlan = Static<typeof VerificationPlanSchema>;
export type RepairPacket = Static<typeof RepairPacketSchema>;
export type RetrievalAction = Static<typeof RetrievalActionSchema>;
export type CheckNode = Static<typeof CheckNodeSchema>;
export type RunObservation = Static<typeof RunObservationSchema>;
export type LocalEvidenceProposal = Static<typeof LocalEvidenceProposalSchema>;
export type LocalSemanticFinding = Static<typeof LocalSemanticFindingSchema>;
export type SemanticVerificationRequest = Static<typeof SemanticVerificationRequestSchema>;
export type SemanticVerificationResult = Static<typeof SemanticVerificationResultSchema>;
export type RetrievalIntent = Static<typeof RetrievalIntentSchema>;
