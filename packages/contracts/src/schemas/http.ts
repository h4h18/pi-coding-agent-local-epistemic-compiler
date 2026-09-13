import { Type, type Static } from "typebox";
import {
  ApprovalIdSchema,
  ArtifactEnvelopeSchema,
  DigestSchema,
  GeneralIdSchema,
  ObjectDigestSchema,
  OperationIdSchema,
  PositiveSafeUintSchema,
  ProjectIdSchema,
  ReasonSchema,
  RunIdSchema,
  SafeUintSchema,
  SnapshotIdSchema,
  TimestampSchema,
  closed,
  utf8BoundedString,
} from "../ids.js";
import { RunAgentsPageSchema } from "./agents.js";
import { SnapshotManifestSchema } from "./artifacts.js";
import {
  OperationKindSchema,
  RunStateSchema,
  RunTransitionEventSchema,
  TaskEnvelopeSchema,
} from "./run.js";
import { ApprovalDecisionSchema, ApprovalGrantSchema } from "./secrets.js";

export const ClassificationSchema = Type.Enum([
  "public",
  "internal",
  "confidential",
  "restricted",
] as const);

export const ProjectPolicySchema = closed({
  schemaVersion: Type.Literal(1),
  projectId: ProjectIdSchema,
  classification: ClassificationSchema,
  trustedInstructionRoots: Type.Array(utf8BoundedString(1024)),
  allowedCloudDeploymentIds: Type.Array(ProjectIdSchema),
  permittedEgressClassifications: Type.Array(
    Type.Enum(["public", "internal", "confidential"] as const),
  ),
  standingApprovalPolicyDigests: Type.Array(ObjectDigestSchema),
});

export const ProjectProjectionSchema = closed({
  schemaVersion: Type.Literal(1),
  projectId: ProjectIdSchema,
  displayName: utf8BoundedString(256),
  trustState: Type.Enum(["untrusted", "trusted", "revoked"] as const),
  classification: ClassificationSchema,
  policyObjectDigest: ObjectDigestSchema,
  stateVersion: SafeUintSchema,
});

export const CreateProjectRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  projectId: ProjectIdSchema,
  displayName: utf8BoundedString(256),
  classification: ClassificationSchema,
  policy: ArtifactEnvelopeSchema(ProjectPolicySchema),
});

export const ApprovalChallengeSchema = closed({
  schemaVersion: Type.Literal(1),
  approvalId: ApprovalIdSchema,
  projectId: ProjectIdSchema,
  scope: Type.Union([
    closed({ kind: Type.Literal("project") }),
    closed({ kind: Type.Literal("run"), runId: RunIdSchema }),
  ]),
  action: Type.Enum([
    "cloud-egress",
    "command",
    "workspace-promotion",
    "project-trust",
    "project-policy",
    "workspace-registration",
  ] as const),
  subjectObjectDigest: ObjectDigestSchema,
  policyObjectDigest: ObjectDigestSchema,
  nonce: utf8BoundedString(128),
  expiresAt: TimestampSchema,
  displayArtifactObjectDigest: ObjectDigestSchema,
});

export const CreateProjectResponseSchema = closed({
  schemaVersion: Type.Literal(1),
  project: ProjectProjectionSchema,
  trustChallenge: ArtifactEnvelopeSchema(ApprovalChallengeSchema),
});

export const UpdateProjectPolicyRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  policy: ArtifactEnvelopeSchema(ProjectPolicySchema),
  approvalId: ApprovalIdSchema,
});

export const SetProjectTrustRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  trustState: Type.Enum(["trusted", "revoked"] as const),
  approvalId: ApprovalIdSchema,
});

export const CreateWorkspaceRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  workspaceId: ProjectIdSchema,
  runnerId: ProjectIdSchema,
  rootFingerprint: utf8BoundedString(256),
  platform: Type.Enum(["windows", "linux", "macos"] as const),
  brokerAttestationObjectDigest: ObjectDigestSchema,
  approvalId: ApprovalIdSchema,
});

export const WorkspaceProjectionSchema = closed({
  schemaVersion: Type.Literal(1),
  projectId: ProjectIdSchema,
  workspaceId: ProjectIdSchema,
  runnerId: ProjectIdSchema,
  rootFingerprint: utf8BoundedString(256),
  platform: Type.Enum(["windows", "linux", "macos"] as const),
  registrationApprovalGrantObjectDigest: ObjectDigestSchema,
  currentSnapshotId: Type.Optional(SnapshotIdSchema),
  recoveryState: Type.Enum(["READY", "RECONCILING", "MANUAL_RECOVERY_REQUIRED"] as const),
  stateVersion: SafeUintSchema,
});

export const RunProjectionSchema = closed({
  schemaVersion: Type.Literal(1),
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  workspaceId: ProjectIdSchema,
  state: RunStateSchema,
  stateVersion: SafeUintSchema,
  snapshotId: Type.Optional(SnapshotIdSchema),
  artifactRoles: Type.Array(
    closed({
      role: utf8BoundedString(128),
      cardinality: Type.Enum(["EXACTLY_ONE", "ZERO_OR_ONE", "ONE_OR_MORE"] as const),
      objectDigests: Type.Array(ObjectDigestSchema),
    }),
  ),
  activeOperationId: Type.Optional(OperationIdSchema),
  terminalResultObjectDigest: Type.Optional(ObjectDigestSchema),
  updatedAt: TimestampSchema,
});

export const RunEventPageSchema = closed({
  schemaVersion: Type.Literal(1),
  events: Type.Array(RunTransitionEventSchema),
  nextAfter: Type.Union([SafeUintSchema, Type.Null()]),
});

export const RunArtifactPageSchema = closed({
  schemaVersion: Type.Literal(1),
  artifacts: Type.Array(
    closed({
      role: utf8BoundedString(128),
      objectDigest: ObjectDigestSchema,
      mediaType: utf8BoundedString(256),
      byteSize: SafeUintSchema,
      classification: ClassificationSchema,
      createdAt: TimestampSchema,
    }),
  ),
  nextCursor: Type.Union([utf8BoundedString(256), Type.Null()]),
});

export const CreateRunRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  workspaceId: ProjectIdSchema,
  task: TaskEnvelopeSchema,
});

export const ProvideInputRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  questionId: GeneralIdSchema,
  answer: utf8BoundedString(16384),
  source: Type.Literal("user"),
});

export const UserInputArtifactSchema = closed({
  schemaVersion: Type.Literal(1),
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  questionId: GeneralIdSchema,
  questionObjectDigest: ObjectDigestSchema,
  answer: utf8BoundedString(16384),
  principalId: GeneralIdSchema,
  answeredAt: TimestampSchema,
  priorRequirementLedgerObjectDigest: ObjectDigestSchema,
});

export const RequestRepairRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  verdictReportObjectDigest: ObjectDigestSchema,
});

export const CancelRunRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  reason: ReasonSchema,
});

export const ApprovalChallengeRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  action: Type.Enum([
    "cloud-egress",
    "command",
    "workspace-promotion",
    "project-trust",
    "project-policy",
    "workspace-registration",
  ] as const),
  subjectObjectDigest: ObjectDigestSchema,
});

export const CommitApprovalRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  challengeObjectDigest: ObjectDigestSchema,
  decision: ArtifactEnvelopeSchema(ApprovalDecisionSchema),
});

export const CommitApprovalResponseSchema = Type.Union([
  closed({
    schemaVersion: Type.Literal(1),
    outcome: Type.Literal("APPROVED"),
    decisionObjectDigest: ObjectDigestSchema,
    grant: ArtifactEnvelopeSchema(ApprovalGrantSchema),
  }),
  closed({
    schemaVersion: Type.Literal(1),
    outcome: Type.Literal("DENIED"),
    decisionObjectDigest: ObjectDigestSchema,
  }),
]);

export const MissingBlobsRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  objectDigests: Type.Array(ObjectDigestSchema, { minItems: 1 }),
});

export const MissingBlobsResponseSchema = closed({
  schemaVersion: Type.Literal(1),
  missingObjectDigests: Type.Array(ObjectDigestSchema),
});

export const SnapshotCommitRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  manifest: ArtifactEnvelopeSchema(SnapshotManifestSchema),
  manifestObjectDigest: ObjectDigestSchema,
});

export const SnapshotProjectionSchema = closed({
  schemaVersion: Type.Literal(1),
  projectId: ProjectIdSchema,
  workspaceId: ProjectIdSchema,
  snapshotId: SnapshotIdSchema,
  rootDigest: DigestSchema,
  manifestObjectDigest: ObjectDigestSchema,
  runnerId: ProjectIdSchema,
  createdAt: TimestampSchema,
});

export const RunnerEnrollmentChallengeSchema = closed({
  schemaVersion: Type.Literal(1),
  challengeId: GeneralIdSchema,
  oneTimeSecret: utf8BoundedString(256),
  permittedProjectIds: Type.Array(ProjectIdSchema, { minItems: 1 }),
  expiresAt: TimestampSchema,
});

export const CreateRunnerEnrollmentChallengeRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  permittedProjectIds: Type.Array(ProjectIdSchema, { minItems: 1 }),
  runnerPlatform: Type.Enum(["windows", "linux", "macos"] as const),
  expiresInSeconds: PositiveSafeUintSchema,
});

export const EnrollRunnerRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  challengeId: GeneralIdSchema,
  oneTimeSecret: utf8BoundedString(256),
  runnerId: ProjectIdSchema,
  publicKeySpki: utf8BoundedString(4096),
  certificateSigningRequestPem: utf8BoundedString(16384),
  proofOfPossession: utf8BoundedString(4096),
  platform: Type.Enum(["windows", "linux", "macos"] as const),
  capabilityObjectDigest: ObjectDigestSchema,
});

export const RunnerIdentityResponseSchema = closed({
  schemaVersion: Type.Literal(1),
  runnerId: ProjectIdSchema,
  certificatePem: utf8BoundedString(16384),
  certificateChainPem: Type.Array(utf8BoundedString(16384)),
  expiresAt: TimestampSchema,
  grantedProjectIds: Type.Array(ProjectIdSchema),
});

export const RevokeRunnerRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  reason: ReasonSchema,
  effectiveAt: TimestampSchema,
});

export const RotateRunnerCertificateRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  publicKeySpki: utf8BoundedString(4096),
  certificateSigningRequestPem: utf8BoundedString(16384),
  proofOfPossession: utf8BoundedString(4096),
});

export const RunnerLeaseRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  runnerId: ProjectIdSchema,
  capabilitiesObjectDigest: ObjectDigestSchema,
  maxJobs: Type.Literal(1),
});

export const RunnerLeaseResponseSchema = Type.Union([
  closed({
    schemaVersion: Type.Literal(1),
    outcome: Type.Literal("NO_JOB"),
    retryAfterMs: SafeUintSchema,
  }),
  closed({
    schemaVersion: Type.Literal(1),
    outcome: Type.Literal("LEASED"),
    projectId: ProjectIdSchema,
    operationId: OperationIdSchema,
    leaseToken: utf8BoundedString(256),
    leaseGeneration: SafeUintSchema,
    leaseExpiresAt: TimestampSchema,
    inputObjectDigest: ObjectDigestSchema,
  }),
]);

export const OperationHeartbeatRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  leaseToken: utf8BoundedString(256),
  leaseGeneration: SafeUintSchema,
  observedInputObjectDigest: ObjectDigestSchema,
});

export const OperationHeartbeatResponseSchema = closed({
  schemaVersion: Type.Literal(1),
  leaseExpiresAt: TimestampSchema,
  cancellationRequested: Type.Boolean(),
});

export const OperationResultRequestSchema = Type.Union([
  closed({
    schemaVersion: Type.Literal(1),
    leaseToken: utf8BoundedString(256),
    leaseGeneration: SafeUintSchema,
    outcome: Type.Literal("SUCCEEDED"),
    resultObjectDigest: ObjectDigestSchema,
  }),
  closed({
    schemaVersion: Type.Literal(1),
    leaseToken: utf8BoundedString(256),
    leaseGeneration: SafeUintSchema,
    outcome: Type.Literal("FAILED"),
    errorObjectDigest: ObjectDigestSchema,
  }),
  closed({
    schemaVersion: Type.Literal(1),
    leaseToken: utf8BoundedString(256),
    leaseGeneration: SafeUintSchema,
    outcome: Type.Literal("UNKNOWN"),
    errorObjectDigest: ObjectDigestSchema,
  }),
]);

export const OperationProjectionSchema = closed({
  schemaVersion: Type.Literal(1),
  projectId: ProjectIdSchema,
  operationId: OperationIdSchema,
  runId: RunIdSchema,
  kind: OperationKindSchema,
  state: Type.Enum(["ready", "leased", "succeeded", "failed", "cancelled", "unknown"] as const),
  leaseGeneration: SafeUintSchema,
  resultObjectDigest: Type.Optional(ObjectDigestSchema),
  errorObjectDigest: Type.Optional(ObjectDigestSchema),
  updatedAt: TimestampSchema,
});

export const ApiErrorSchema = closed({
  schemaVersion: Type.Literal(1),
  code: Type.Enum([
    "SCHEMA_INVALID",
    "AUTHENTICATION_FAILED",
    "NOT_FOUND",
    "OPERATION_ID_REUSED",
    "STATE_VERSION_MISMATCH",
    "PRECONDITION_REQUIRED",
    "CONTENT_DIGEST_MISMATCH",
    "CONTENT_TOO_LARGE",
    "MEDIA_TYPE_UNSUPPORTED",
    "DOMAIN_INVARIANT_FAILED",
    "LEASE_INVALID",
    "LEASE_EXPIRED",
    "RANGE_NOT_SATISFIABLE",
    "WORKSPACE_RECOVERY_REQUIRED",
    "TEMPORARILY_UNAVAILABLE",
    "INTERNAL",
  ] as const),
  message: ReasonSchema,
  retryClass: Type.Enum(["never", "safe", "ambiguous", "after-user-action"] as const),
  operationId: Type.Optional(OperationIdSchema),
  runId: Type.Optional(RunIdSchema),
  evidenceObjectDigest: Type.Optional(ObjectDigestSchema),
});

export const HttpEventsQuerySchema = closed({
  after: Type.Optional(SafeUintSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const HttpArtifactsQuerySchema = closed({
  after: Type.Optional(utf8BoundedString(256)),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export type ApiOperationClass = "mut-sync" | "mut-run" | "content" | "lease" | "read";
export type ApiAudience = "admin" | "broker" | "runner" | "worker" | "owning-runner" | "bootstrap";

export type HttpOperationSpec = {
  operationId: string;
  method: "GET" | "PUT" | "POST";
  path: string;
  audiences: readonly ApiAudience[];
  requestSchemaName: string | null;
  success: readonly { status: number; schemaName: string | null }[];
  class: ApiOperationClass;
  errorProfile: string;
  responseHeaders: readonly string[];
};

export const MUTATION_SIGNATURE_COMPONENTS = [
  "@method",
  "@authority",
  "@target-uri",
  "content-digest",
  "content-type",
  "content-length",
  "operation-id",
  "x-hec-issued-at",
  "x-hec-expires-at",
  "x-hec-nonce",
] as const;

export type ProjectPolicy = Static<typeof ProjectPolicySchema>;
export type CreateProjectRequest = Static<typeof CreateProjectRequestSchema>;
export type ProjectProjection = Static<typeof ProjectProjectionSchema>;
export type RunProjection = Static<typeof RunProjectionSchema>;
export type ApiError = Static<typeof ApiErrorSchema>;
export type WorkspaceProjection = Static<typeof WorkspaceProjectionSchema>;
export type OperationProjection = Static<typeof OperationProjectionSchema>;
export type ApprovalChallenge = Static<typeof ApprovalChallengeSchema>;
export type SnapshotProjection = Static<typeof SnapshotProjectionSchema>;
export type CommitApprovalRequest = Static<typeof CommitApprovalRequestSchema>;
export type CommitApprovalResponse = Static<typeof CommitApprovalResponseSchema>;
export type UserInputArtifact = Static<typeof UserInputArtifactSchema>;
export type RunnerLeaseResponse = Static<typeof RunnerLeaseResponseSchema>;
export type OperationResultRequest = Static<typeof OperationResultRequestSchema>;
export { RunAgentsPageSchema };
export type { RunAgentsPage } from "./agents.js";
