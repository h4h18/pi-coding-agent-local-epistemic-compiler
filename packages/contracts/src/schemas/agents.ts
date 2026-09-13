import { Type, type Static } from "typebox";
import {
  AgentIdSchema,
  CapabilityTokenIdSchema,
  DigestSchema,
  GeneralIdSchema,
  LeaseIdSchema,
  NormalizedPathSchema,
  ObjectDigestSchema,
  ReasonSchema,
  RequirementIdSchema,
  RunIdSchema,
  SafeUintSchema,
  TimestampSchema,
  closed,
  utf8BoundedString,
} from "../ids.js";
import { CommandSpecSchema } from "./artifacts.js";

export const AGENT_ROLES = [
  "analyst",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "spec-reviewer",
  "security-reviewer",
  "architecture-reviewer",
  "test-reviewer",
  "performance-reviewer",
  "conflict-resolver",
  "final-synthesizer",
] as const;

export const TASK_KINDS = ["feature", "bugfix", "research", "spec", "refactor"] as const;

export const WORKFLOW_PROFILE_IDS = [
  "FAST",
  "STANDARD",
  "HIGH_RISK",
  "RESEARCH",
  "SPEC_ONLY",
  "FEATURE",
  "BUGFIX",
  "REFACTOR",
] as const;

export const NODE_STATUSES = [
  "PENDING",
  "SPAWNED",
  "WAITING_ARTIFACT",
  "VALIDATING",
  "ACCEPTED",
  "RETRYING",
  "FAILED",
] as const;

export const TOOL_PROFILES = ["read", "write", "review"] as const;

export const CONCURRENCY_GROUPS = ["read", "write", "review"] as const;

export const CONTROLLER_OPERATIONS = [
  "DETERMINISTIC_INTEGRATION",
  "VERIFICATION",
  "REGRESSION_VERIFICATION",
  "BASELINE_CHARACTERIZATION",
  "BEHAVIORAL_EQUIVALENCE",
  "SPEC_CONSISTENCY",
  "EVIDENCE_COMPLETENESS",
  "CONSISTENCY_GATE",
  "ACCEPTANCE",
] as const;

export const AGENT_NODE_EVENT_TYPES = [
  "NODE_SPAWNED",
  "ARTIFACT_ACCEPTED",
  "NODE_FAILED",
  "NODE_COMPLETED",
  "NODE_RETRYING",
  "NODE_BLOCKED",
  "NODE_STEERED",
] as const;

export const RUNTIME_ADAPTER_IDS = [
  "control-plane-session",
  "direct-provider-loop",
  "pi-subagents",
] as const;

export const ARTIFACT_TYPES = [
  "task-contract",
  "investigation-report",
  "implementation-plan",
  "change-shards",
  "change-manifest",
  "changeset",
  "review-findings",
  "command-evidence",
  "verdict-report",
  "acceptance-ledger",
  "reproduction-unavailable",
  "spec-update-not-required",
] as const;

export const RISK_FLAGS = [
  "public-api",
  "auth",
  "secrets",
  "crypto",
  "payment",
  "migration",
  "concurrency",
  "behavior-change",
  "no-tests",
  "unstable-bug",
  "multi-subsystem",
] as const;

export const AgentRoleSchema = Type.Enum(AGENT_ROLES);
export const TaskKindSchema = Type.Enum(TASK_KINDS);
export const WorkflowProfileIdSchema = Type.Enum(WORKFLOW_PROFILE_IDS);
export const NodeStatusSchema = Type.Enum(NODE_STATUSES);
export const ToolProfileSchema = Type.Enum(TOOL_PROFILES);
export const ConcurrencyGroupSchema = Type.Enum(CONCURRENCY_GROUPS);
export const ControllerOperationSchema = Type.Enum(CONTROLLER_OPERATIONS);
export const AgentNodeEventTypeSchema = Type.Enum(AGENT_NODE_EVENT_TYPES);
export const RuntimeAdapterIdSchema = Type.Enum(RUNTIME_ADAPTER_IDS);
export const ArtifactTypeSchema = Type.Enum(ARTIFACT_TYPES);
export const RiskFlagSchema = Type.Enum(RISK_FLAGS);

export const WorkflowNodeKeySchema = Type.String({
  pattern: "^[a-z][a-z0-9-]{0,63}$",
  minLength: 1,
  maxLength: 64,
});

export const ArtifactReferenceSchema = closed({
  role: utf8BoundedString(128),
  objectDigest: ObjectDigestSchema,
});

export const EvidenceRefTextSchema = utf8BoundedString(1024);

export const ContractAssumptionSchema = closed({
  id: utf8BoundedString(64),
  text: utf8BoundedString(16384),
  reversible: Type.Boolean(),
  evidence: Type.Array(EvidenceRefTextSchema, { maxItems: 64 }),
});

export const AcceptanceCriterionSchema = closed({
  id: utf8BoundedString(64),
  statement: utf8BoundedString(16384),
  verification: Type.Array(
    Type.Enum(["test", "inspection", "runtime", "review", "reproduction"] as const),
    { minItems: 1, maxItems: 8 },
  ),
  requiredEvidence: Type.Array(
    Type.Enum(["command", "diff", "review", "inspection", "reproduction"] as const),
    { minItems: 1, maxItems: 8 },
  ),
});

export const SpecPolicySchema = closed({
  paths: Type.Array(NormalizedPathSchema, { maxItems: 64 }),
  behaviorChanges: Type.Boolean(),
  updateRequired: Type.Boolean(),
});

export const TaskContractSchema = closed({
  schemaVersion: Type.Literal(1),
  taskId: utf8BoundedString(128),
  kind: TaskKindSchema,
  objective: utf8BoundedString(16384),
  inScope: Type.Array(utf8BoundedString(4096), { maxItems: 64 }),
  outOfScope: Type.Array(utf8BoundedString(4096), { maxItems: 64 }),
  constraints: Type.Array(utf8BoundedString(4096), { maxItems: 64 }),
  assumptions: Type.Array(ContractAssumptionSchema, { maxItems: 64 }),
  acceptanceCriteria: Type.Array(AcceptanceCriterionSchema, { minItems: 1, maxItems: 64 }),
  riskFlags: Type.Array(RiskFlagSchema, { maxItems: 32 }),
  specPolicy: SpecPolicySchema,
  blockingQuestions: Type.Array(utf8BoundedString(4096), { maxItems: 32 }),
});

export const InvestigationFindingSchema = closed({
  id: utf8BoundedString(64),
  claim: utf8BoundedString(16384),
  evidence: Type.Array(EvidenceRefTextSchema, { minItems: 1, maxItems: 64 }),
  severity: Type.Enum(["info", "low", "medium", "high", "critical"] as const),
});

export const InvestigationReportSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  agentId: AgentIdSchema,
  kind: Type.Enum([
    "code",
    "spec",
    "history",
    "reproduction",
    "root-cause",
    "constraint",
    "dependency",
    "external",
  ] as const),
  findings: Type.Array(InvestigationFindingSchema, { maxItems: 128 }),
  contradictions: Type.Array(
    closed({
      left: utf8BoundedString(64),
      right: utf8BoundedString(64),
      explanation: ReasonSchema,
    }),
    { maxItems: 32 },
  ),
  openQuestions: Type.Array(utf8BoundedString(4096), { maxItems: 32 }),
  reproduction: Type.Optional(
    closed({
      available: Type.Boolean(),
      command: Type.Optional(CommandSpecSchema),
      notes: utf8BoundedString(4096),
    }),
  ),
  rootCause: Type.Optional(
    closed({
      claim: utf8BoundedString(16384),
      evidence: Type.Array(EvidenceRefTextSchema, { minItems: 1, maxItems: 64 }),
    }),
  ),
});

export const ChangeShardSchema = closed({
  id: utf8BoundedString(64),
  files: Type.Array(NormalizedPathSchema, { maxItems: 256 }),
  symbols: Type.Array(utf8BoundedString(512), { maxItems: 256 }),
  contractsConsumed: Type.Array(utf8BoundedString(256), { maxItems: 64 }),
  contractsModified: Type.Array(utf8BoundedString(256), { maxItems: 64 }),
  generatedOutputs: Type.Array(NormalizedPathSchema, { maxItems: 64 }),
  sharedResources: Type.Array(utf8BoundedString(256), { maxItems: 64 }),
  dependsOn: Type.Array(utf8BoundedString(64), { maxItems: 32 }),
});

export const ImplementationPlanSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  agentId: AgentIdSchema,
  steps: Type.Array(
    closed({
      id: utf8BoundedString(64),
      description: utf8BoundedString(4096),
      files: Type.Array(NormalizedPathSchema, { maxItems: 64 }),
      dependsOn: Type.Array(utf8BoundedString(64), { maxItems: 32 }),
      verification: utf8BoundedString(1024),
    }),
    { minItems: 1, maxItems: 64 },
  ),
  shards: Type.Array(ChangeShardSchema, { maxItems: 32 }),
  risks: Type.Array(utf8BoundedString(4096), { maxItems: 32 }),
  outOfScope: Type.Array(utf8BoundedString(4096), { maxItems: 32 }),
});

export const ChangeShardsSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  shards: Type.Array(ChangeShardSchema, { minItems: 1, maxItems: 32 }),
});

export const ChangeManifestSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  agentId: AgentIdSchema,
  leaseId: LeaseIdSchema,
  baseCommit: utf8BoundedString(64),
  integrationCommit: Type.Optional(utf8BoundedString(64)),
  changedPaths: Type.Array(NormalizedPathSchema, { maxItems: 1024 }),
  specPaths: Type.Array(NormalizedPathSchema, { maxItems: 64 }),
  producedFromPlanDigest: Type.Optional(ObjectDigestSchema),
  allowedPaths: Type.Array(NormalizedPathSchema, { maxItems: 1024 }),
});

export const ReviewFindingSchema = closed({
  id: utf8BoundedString(64),
  severity: Type.Enum(["info", "low", "medium", "high", "critical"] as const),
  category: Type.Enum([
    "correctness",
    "security",
    "architecture",
    "test",
    "performance",
    "spec",
    "policy",
    "scope",
  ] as const),
  claim: utf8BoundedString(16384),
  evidence: Type.Array(EvidenceRefTextSchema, { minItems: 1, maxItems: 64 }),
  violates: Type.Array(utf8BoundedString(64), { maxItems: 16 }),
  reproduction: utf8BoundedString(4096),
  remediationCheck: utf8BoundedString(4096),
});

export const ReviewFindingsSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  agentId: AgentIdSchema,
  findings: Type.Array(ReviewFindingSchema, { maxItems: 128 }),
  blocking: Type.Boolean(),
  summary: utf8BoundedString(4096),
});

export const CommandEvidenceSchema = closed({
  schemaVersion: Type.Literal(1),
  evidenceId: utf8BoundedString(128),
  producedBy: Type.Literal("controller"),
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  commitSha: utf8BoundedString(64),
  workspaceLeaseId: LeaseIdSchema,
  executable: utf8BoundedString(1024),
  args: Type.Array(utf8BoundedString(4096), { maxItems: 256 }),
  cwd: utf8BoundedString(4096),
  environmentDigest: DigestSchema,
  startedAt: TimestampSchema,
  durationMs: SafeUintSchema,
  exitCode: Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
  stdoutDigest: DigestSchema,
  stderrDigest: DigestSchema,
  artifactPaths: Type.Array(NormalizedPathSchema, { maxItems: 64 }),
});

export const AcceptanceCriterionStatusSchema = Type.Enum([
  "proven",
  "unproven",
  "pre-existing",
  "inconclusive",
] as const);

export const AcceptanceLedgerSchema = closed({
  schemaVersion: Type.Literal(1),
  contractRevision: SafeUintSchema,
  integrationCommit: utf8BoundedString(64),
  criteria: Type.Array(
    closed({
      id: utf8BoundedString(64),
      requirementId: Type.Optional(RequirementIdSchema),
      status: AcceptanceCriterionStatusSchema,
      evidence: Type.Array(EvidenceRefTextSchema, { maxItems: 32 }),
    }),
    { minItems: 1, maxItems: 64 },
  ),
  unproven: Type.Array(utf8BoundedString(64), { maxItems: 64 }),
  preExistingFailures: Type.Array(utf8BoundedString(256), { maxItems: 64 }),
  closed: Type.Boolean(),
});

export const RetryPolicySchema = closed({
  maxAttempts: Type.Integer({ minimum: 1, maximum: 16 }),
  retryOn: Type.Array(
    Type.Enum(["validation", "runtime", "lost-session", "blocker"] as const),
    { maxItems: 8 },
  ),
});

export const WorkflowNodeSchema = closed({
  id: WorkflowNodeKeySchema,
  role: Type.Optional(AgentRoleSchema),
  operation: Type.Optional(ControllerOperationSchema),
  dependsOn: Type.Array(WorkflowNodeKeySchema, { maxItems: 32 }),
  when: Type.Optional(utf8BoundedString(256)),
  retryPolicy: RetryPolicySchema,
  invalidates: Type.Array(WorkflowNodeKeySchema, { maxItems: 32 }),
  concurrencyGroup: Type.Optional(ConcurrencyGroupSchema),
});

export const AcceptancePolicySchema = closed({
  requireReviewer: Type.Boolean(),
  requireCommandEvidence: Type.Boolean(),
  requireFreshReviewAfterRepair: Type.Boolean(),
  allowResearchWithoutWrite: Type.Boolean(),
});

export const WorkflowProfileSchema = closed({
  schemaVersion: Type.Literal(1),
  id: WorkflowProfileIdSchema,
  appliesTo: Type.Array(TaskKindSchema, { minItems: 1, maxItems: 8 }),
  nodes: Type.Array(WorkflowNodeSchema, { minItems: 1, maxItems: 64 }),
  requiredArtifacts: Type.Array(ArtifactTypeSchema, { minItems: 1, maxItems: 32 }),
  acceptancePolicy: AcceptancePolicySchema,
});

export const SkillLockSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  mandatorySkillIds: Type.Array(utf8BoundedString(128), { maxItems: 64 }),
  optionalSkillIds: Type.Array(utf8BoundedString(128), { maxItems: 64 }),
  omittedSkillIds: Type.Array(utf8BoundedString(128), { maxItems: 128 }),
  reasons: Type.Array(
    closed({
      skillId: utf8BoundedString(128),
      reason: utf8BoundedString(1024),
    }),
    { maxItems: 128 },
  ),
  rankedByLocalModel: Type.Boolean(),
});

export const WorkspaceLeaseSchema = closed({
  schemaVersion: Type.Literal(1),
  leaseId: LeaseIdSchema,
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  overlayPath: utf8BoundedString(4096),
  branch: utf8BoundedString(256),
  baseCommit: utf8BoundedString(64),
  allowedPaths: Type.Array(NormalizedPathSchema, { maxItems: 1024 }),
  isolationVerified: Type.Boolean(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
});

export const AgentSessionRecordSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  agentId: AgentIdSchema,
  role: AgentRoleSchema,
  adapter: RuntimeAdapterIdSchema,
  adapterVersion: utf8BoundedString(64),
  sessionId: utf8BoundedString(256),
  toolProfile: ToolProfileSchema,
  modelDeploymentId: utf8BoundedString(128),
  capabilityTokenId: CapabilityTokenIdSchema,
  inheritTranscriptFrom: Type.Optional(AgentIdSchema),
  spawnedAt: TimestampSchema,
  lastHeartbeatAt: TimestampSchema,
  status: NodeStatusSchema,
});

export const CapabilityTokenSchema = closed({
  schemaVersion: Type.Literal(1),
  tokenId: CapabilityTokenIdSchema,
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  agentId: AgentIdSchema,
  role: AgentRoleSchema,
  toolProfile: ToolProfileSchema,
  allowedArtifactTypes: Type.Array(ArtifactTypeSchema, { minItems: 1, maxItems: 16 }),
  leaseId: Type.Optional(LeaseIdSchema),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  nonce: utf8BoundedString(128),
});

export const ReproductionUnavailableSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  reason: ReasonSchema,
  evidence: Type.Array(EvidenceRefTextSchema, { maxItems: 32 }),
});

export const SpecUpdateNotRequiredSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  reason: ReasonSchema,
  evidence: Type.Array(EvidenceRefTextSchema, { maxItems: 32 }),
});

export const WorkerArtifactEnvelopeSchema = closed({
  schemaVersion: Type.Literal(1),
  artifactType: ArtifactTypeSchema,
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  agentId: AgentIdSchema,
  producedFromCommit: Type.Optional(utf8BoundedString(64)),
  inputs: Type.Array(ArtifactReferenceSchema, { maxItems: 64 }),
  payload: Type.Unknown(),
});

export const AgentNodeEventSchema = closed({
  schemaVersion: Type.Literal(1),
  eventId: GeneralIdSchema,
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  sequence: SafeUintSchema,
  type: AgentNodeEventTypeSchema,
  actor: Type.Literal("control"),
  agentId: Type.Optional(AgentIdSchema),
  timestamp: TimestampSchema,
  payloadHash: DigestSchema,
  payload: Type.Unknown(),
});

export const ProjectAdapterSchema = closed({
  schemaVersion: Type.Literal(1),
  project: closed({
    id: utf8BoundedString(128),
    adapter: utf8BoundedString(64),
  }),
  spec: closed({
    roots: Type.Array(NormalizedPathSchema, { maxItems: 16 }),
    behaviorChangeRequiresUpdate: Type.Boolean(),
  }),
  verification: closed({
    baseline: Type.Array(CommandSpecSchema, { maxItems: 32 }),
    targeted: Type.Array(CommandSpecSchema, { maxItems: 32 }),
    final: Type.Array(CommandSpecSchema, { maxItems: 32 }),
  }),
  protectedPaths: Type.Array(utf8BoundedString(256), { maxItems: 64 }),
  network: closed({
    default: Type.Literal("deny"),
    externalResearch: Type.Enum(["allow", "deny"] as const),
  }),
});

export const RuntimeConfigSchema = closed({
  schemaVersion: Type.Literal(1),
  runtime: closed({
    adapter: RuntimeAdapterIdSchema,
    maxReadOnlyConcurrency: Type.Integer({ minimum: 1, maximum: 32 }),
    maxWriterConcurrency: Type.Literal(1),
    nestedDelegation: Type.Literal(false),
    persistSessions: Type.Boolean(),
  }),
  models: closed({
    local: closed({
      capabilities: Type.Array(
        Type.Enum(["classification", "retrieval-ranking"] as const),
        { minItems: 1, maxItems: 2 },
      ),
    }),
    cloud: Type.Record(Type.String(), utf8BoundedString(128)),
  }),
  workspace: closed({
    mode: Type.Literal("snapshot-overlay"),
    verifyIsolation: Type.Literal(true),
    applyToUserTree: Type.Literal("explicit"),
  }),
  telemetry: closed({
    external: Type.Literal(false),
    localRunHistory: Type.Boolean(),
    showTokens: Type.Boolean(),
    showCost: Type.Boolean(),
    enforceBudget: Type.Literal(false),
  }),
});

export const AgentProjectionSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  agentId: AgentIdSchema,
  role: AgentRoleSchema,
  status: NodeStatusSchema,
  toolProfile: ToolProfileSchema,
  sessionId: utf8BoundedString(256),
  adapter: RuntimeAdapterIdSchema,
  attempt: SafeUintSchema,
  artifactType: Type.Optional(ArtifactTypeSchema),
  artifactObjectDigest: Type.Optional(ObjectDigestSchema),
  leaseId: Type.Optional(LeaseIdSchema),
  spawnedAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const RunAgentsPageSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  profileId: Type.Optional(WorkflowProfileIdSchema),
  state: utf8BoundedString(64),
  agents: Type.Array(AgentProjectionSchema, { maxItems: 128 }),
});

export const SpawnRequestSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  nodeId: WorkflowNodeKeySchema,
  role: AgentRoleSchema,
  modelDeploymentId: utf8BoundedString(128),
  toolProfile: ToolProfileSchema,
  workspaceLeaseId: Type.Optional(LeaseIdSchema),
  inputArtifacts: Type.Array(ArtifactReferenceSchema, { maxItems: 64 }),
  outputSchema: ArtifactTypeSchema,
  idempotencyKey: utf8BoundedString(256),
  inheritTranscriptFrom: Type.Optional(AgentIdSchema),
});

export type AgentRole = Static<typeof AgentRoleSchema>;
export type TaskKind = Static<typeof TaskKindSchema>;
export type WorkflowProfileId = Static<typeof WorkflowProfileIdSchema>;
export type NodeStatus = Static<typeof NodeStatusSchema>;
export type ToolProfile = Static<typeof ToolProfileSchema>;
export type ArtifactType = Static<typeof ArtifactTypeSchema>;
export type RiskFlag = Static<typeof RiskFlagSchema>;
export type TaskContract = Static<typeof TaskContractSchema>;
export type InvestigationReport = Static<typeof InvestigationReportSchema>;
export type ImplementationPlan = Static<typeof ImplementationPlanSchema>;
export type ChangeShard = Static<typeof ChangeShardSchema>;
export type ChangeShards = Static<typeof ChangeShardsSchema>;
export type ChangeManifest = Static<typeof ChangeManifestSchema>;
export type ReviewFinding = Static<typeof ReviewFindingSchema>;
export type ReviewFindings = Static<typeof ReviewFindingsSchema>;
export type CommandEvidence = Static<typeof CommandEvidenceSchema>;
export type AcceptanceLedger = Static<typeof AcceptanceLedgerSchema>;
export type WorkflowNode = Static<typeof WorkflowNodeSchema>;
export type WorkflowProfile = Static<typeof WorkflowProfileSchema>;
export type SkillLock = Static<typeof SkillLockSchema>;
export type WorkspaceLease = Static<typeof WorkspaceLeaseSchema>;
export type AgentSessionRecord = Static<typeof AgentSessionRecordSchema>;
export type CapabilityToken = Static<typeof CapabilityTokenSchema>;
export type ReproductionUnavailable = Static<typeof ReproductionUnavailableSchema>;
export type SpecUpdateNotRequired = Static<typeof SpecUpdateNotRequiredSchema>;
export type WorkerArtifactEnvelope = Static<typeof WorkerArtifactEnvelopeSchema>;
export type AgentNodeEvent = Static<typeof AgentNodeEventSchema>;
export type ProjectAdapter = Static<typeof ProjectAdapterSchema>;
export type RuntimeConfig = Static<typeof RuntimeConfigSchema>;
export type AgentProjection = Static<typeof AgentProjectionSchema>;
export type RunAgentsPage = Static<typeof RunAgentsPageSchema>;
export type SpawnRequest = Static<typeof SpawnRequestSchema>;
export type ArtifactReference = Static<typeof ArtifactReferenceSchema>;
export type AcceptancePolicy = Static<typeof AcceptancePolicySchema>;
export type ControllerOperation = Static<typeof ControllerOperationSchema>;
export type AgentNodeEventType = Static<typeof AgentNodeEventTypeSchema>;
export type RuntimeAdapterId = Static<typeof RuntimeAdapterIdSchema>;
export type RetryPolicy = Static<typeof RetryPolicySchema>;
