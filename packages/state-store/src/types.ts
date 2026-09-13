import type {
  ObjectDigest,
  PrincipalScope,
  ProjectScope,
  RunDomainEvent,
  RunId,
  VerifiedArtifactSet,
} from "@pi-hec/domain";
import type { Argon2idParameters } from "./crypto.js";
import type { CrashController } from "./crash.js";
import type { SqliteDatabase } from "./sqlite.js";

export type Classification = "public" | "internal" | "confidential" | "restricted";
export type TrustState = "untrusted" | "trusted" | "revoked";
export type EncryptionAlgorithm = "AES-256-GCM" | "XCHACHA20-POLY1305";
export type SignatureAlgorithm = "Ed25519" | "ECDSA-P256-SHA256";

export type ArtifactInput = {
  digest: ObjectDigest;
  schemaName: string | null;
  mediaType: string;
  byteSize: number;
  classification: Classification;
  encryptionAlgorithm: EncryptionAlgorithm;
  encryptionKeyId: string;
  encryptionNonce: string;
  storageRecordDigest: string;
  storageRecordSigningKeyId: string;
  storageRecordSignatureAlgorithm: SignatureAlgorithm;
  storageRecordSignedAt: string;
  storageRecordSignerCertificateDigest: string;
  storageRecordSignature: string;
  createdAt: string;
};

export type HostAuthorityArtifactInput = {
  objectDigest: string;
  schemaName: string;
  mediaType: string;
  byteSize: number;
  encryptionKeyId: string;
  encryptionNonce: string;
  signatureKeyId: string;
  signature: string;
  createdAt: string;
};

export type HostAuthorityArtifactRecord = HostAuthorityArtifactInput;

export type CreateProjectInput = {
  projectId: string;
  displayName: string;
  classification: Classification;
  policy: ArtifactInput;
  createdAt: string;
};

export type SetProjectTrustInput = {
  projectId: string;
  nextTrustState: "trusted" | "revoked";
  approvalId: string;
  principalId: string;
  subjectDigest: ObjectDigest;
  hostPolicyDigest: string;
  challengeDigest: ObjectDigest;
  decisionDigest: ObjectDigest;
  grantDigest: ObjectDigest;
  displayArtifactDigest: ObjectDigest;
  nonceHash: string;
  expiresAt: string;
  createdAt: string;
  consumedAt: string;
  outcome: "approved" | "denied";
};

export type ProjectRecord = {
  projectId: string;
  displayName: string;
  trustState: TrustState;
  classification: Classification;
  policyDigest: string;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateRunnerInput = {
  runnerId: string;
  principalId: string;
  platform: string;
  capabilityDigest: string;
  lastSeenAt: string;
};

export type GrantRunnerInput = {
  runnerId: string;
  capabilityPolicyDigest: string;
  createdAt: string;
};

export type RevokeRunnerGrantInput = {
  runnerId: string;
  revokedAt: string;
};

export type EnrollmentInput = {
  challengeId: string;
  secret: Uint8Array;
  permittedProjectsDigest: string;
  expiresAt: string;
  createdByPrincipalId: string;
  createdAt: string;
};

export type CreateWorkspaceInput = {
  workspaceId: string;
  runnerId: string;
  rootFingerprint: string;
  platform: string;
  brokerAttestationDigest: ObjectDigest;
  registrationGrantDigest: ObjectDigest;
  createdAt: string;
};

export type CreateSnapshotInput = {
  snapshotId: string;
  workspaceId: string;
  rootDigest: ObjectDigest;
  manifestDigest: ObjectDigest;
  runnerId: string;
  createdAt: string;
};

export type RoleBindingInput = {
  snapshotId: string;
  role: string;
  artifactDigest: ObjectDigest;
  createdAt: string;
};

export type CreateRunInput = {
  runId: RunId;
  workspaceId: string;
  taskEnvelopeDigest: ObjectDigest;
  createdAt: string;
};

export type PersistRunEventInput = {
  event: RunDomainEvent;
  artifacts: VerifiedArtifactSet;
  payloadDigest: ObjectDigest;
};

export type StoredRunEvent = {
  eventId: string;
  runId: string;
  sequence: number;
  eventType: string;
  actorType: string;
  actorId: string;
  payloadDigest: string;
  occurredAt: string;
};

export type EnqueueOperationInput = {
  operationId: string;
  runId: string;
  operationKind: string;
  dedupeKey: string;
  inputDigest: ObjectDigest;
  createdAt: string;
};

export type OperationRecord = {
  operationId: string;
  runId: string;
  operationKind: string;
  dedupeKey: string;
  inputDigest: string;
  state: string;
  reclaimable: boolean;
  leaseGeneration: number;
  leaseOwner: string | undefined;
  resultDigest: string | undefined;
  errorDigest: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type LeaseOperationInput = {
  operationId: string;
  owner: string;
  leaseUntil: string;
  now: string;
};

export type LeaseResult = {
  token: string;
  generation: number;
  leaseUntil: string;
};

export type HeartbeatInput = {
  operationId: string;
  token: string;
  owner: string;
  leaseUntil: string;
  now: string;
  leaseGeneration?: number;
  observedInputDigest?: string;
};

export type CompleteOperationInput = {
  operationId: string;
  token: string;
  owner: string;
  resultDigest: ObjectDigest;
  now: string;
  updatedAt: string;
  leaseGeneration?: number;
};

export type FailOperationInput = {
  operationId: string;
  token: string;
  owner: string;
  errorDigest: ObjectDigest;
  now: string;
  updatedAt: string;
  leaseGeneration?: number;
};

export type ReserveIdempotencyInput = {
  operationId: string;
  scopeKey: string;
  method: string;
  targetUri: string;
  semanticRequestDigest: string;
  createdAt: string;
  expiresAt: string;
};

export type IdempotencyReplay = {
  state: "completed" | "failed";
  responseStatus: number;
  headers: Buffer;
  body: Buffer;
};

export type IdempotencyReservation = { state: "reserved" } | IdempotencyReplay;

export type CompleteIdempotencyInput = {
  operationId: string;
  scopeKey: string;
  semanticRequestDigest: string;
  responseStatus: number;
  headers: Uint8Array;
  body: Uint8Array;
  updatedAt: string;
};

export type CreateCloudCallInput = {
  cloudCallId: string;
  runId: string;
  purpose: "initial" | "context-followup" | "repair";
  deploymentId: string;
  requestDigest: ObjectDigest;
  contextPacketDigest: ObjectDigest;
  recoveryGrade: "A" | "B" | "C";
  state:
    | "prepared"
    | "dispatching"
    | "in-flight"
    | "completed"
    | "failed"
    | "outcome-unknown"
    | "cancelled";
  createdAt: string;
  responseDigest?: ObjectDigest;
};

export type CloudCallBindingInput = {
  cloudCallId: string;
  role: string;
  artifactDigest: ObjectDigest;
  createdAt: string;
};

export type CloudCallState = CreateCloudCallInput["state"];

export type CloudCallRecord = {
  cloudCallId: string;
  runId: string;
  purpose: CreateCloudCallInput["purpose"];
  deploymentId: string;
  requestDigest: ObjectDigest;
  contextPacketDigest: ObjectDigest;
  recoveryGrade: "A" | "B" | "C";
  state: CloudCallState;
  responseDigest?: ObjectDigest;
  createdAt: string;
  updatedAt: string;
};

export type TransitionCloudCallToDispatchingInput = {
  cloudCallId: string;
  requestDigest: ObjectDigest;
  attemptId: string;
  requestStartedAt: string;
  updatedAt: string;
};

export type CloudTransportAttemptOutcome =
  | "not-dispatched"
  | "failed-before-acceptance"
  | "accepted"
  | "completed"
  | "accepted-outcome-unknown"
  | "reconciled";

export type CloudTransportAttemptRecord = {
  attemptId: string;
  cloudCallId: string;
  attemptNumber: number;
  requestStartedAt: string;
  outcome: CloudTransportAttemptOutcome;
  responseStartedAt?: string;
  completedAt?: string;
  providerRequestId?: string;
};

export type RecordCloudTransportAttemptInput = {
  cloudCallId: string;
  requestStartedAt: string;
  outcome: CloudTransportAttemptOutcome;
  responseStartedAt?: string;
  completedAt?: string;
  providerRequestId?: string;
};

export type SettleCloudCallTransportInput = {
  cloudCallId: string;
  requestStartedAt: string;
  updatedAt: string;
  attemptOutcome: CloudTransportAttemptOutcome;
  nextState: Extract<CloudCallState, "prepared" | "failed" | "outcome-unknown">;
};

export type CompleteCloudCallInput = {
  cloudCallId: string;
  responseDigest: ObjectDigest;
  updatedAt: string;
};

export type OperationBindingInput = {
  operationId: string;
  role: string;
  artifactDigest: ObjectDigest;
  createdAt: string;
};

export type UsageInput = {
  usageEntryId: string;
  cloudCallId: string;
  createdAt: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  normalizedTotalTokens?: number;
  providerReported: boolean;
  complete: boolean;
  currency?: string;
  estimatedCostDecimal?: string;
  pricingSnapshotDigest?: ObjectDigest;
  correctionOf?: string;
};

export type UsageRecord = {
  usageEntryId: string;
  cloudCallId: string;
  runId: string;
  workspaceId: string;
  createdAt: string;
  correctionOf: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  reasoningTokens: number | undefined;
  cachedInputTokens: number | undefined;
  cacheWriteTokens: number | undefined;
  normalizedTotalTokens: number | undefined;
  providerReported: boolean;
  complete: boolean;
  currency: string | undefined;
  estimatedCostDecimal: string | undefined;
  pricingSnapshotDigest: ObjectDigest | undefined;
};

export type UsageEntryRecord = UsageRecord;

export type CloudCallOutcomeRecord = {
  cloudCallId: string;
  runId: string;
  workspaceId: string;
  state: string;
  createdAt: string;
};

export type ApprovalRecord = {
  approvalId: string;
  runId: string | undefined;
  action: string;
  principalId: string;
  grantDigest: string;
};

export type RunnerCertificateRecord = {
  certificateSerial: string;
  runnerId: string;
  spkiSha256: string;
  notBefore: string;
  notAfter: string;
  issuedAt: string;
  revokedAt: string | undefined;
};

export type InsertRunnerCertificateInput = {
  certificateSerial: string;
  runnerId: string;
  spkiSha256: string;
  notBefore: string;
  notAfter: string;
  issuedAt: string;
};

export type OpenApprovalChallengeInput = {
  approvalId: string;
  runId: string | undefined;
  action: string;
  principalId: string;
  subjectDigest: ObjectDigest;
  policyDigest: string;
  displayArtifactDigest: ObjectDigest;
  challengeDigest: ObjectDigest;
  nonceHash: string;
  expiresAt: string;
  createdAt: string;
};

export type ConsumeApprovalInput = {
  approvalId: string;
  challengeDigest: ObjectDigest;
  decisionDigest: ObjectDigest;
  grantDigest: ObjectDigest;
  outcome: "approved" | "denied";
  consumedAt: string;
  expiresAt: string;
};

export type UpdateProjectPolicyInput = {
  projectId: string;
  policy: ArtifactInput;
  approvalId: string;
  expectedStateVersion: number;
  createdAt: string;
};

export type WorkspaceRecord = {
  projectId: string;
  workspaceId: string;
  runnerId: string;
  rootFingerprint: string;
  platform: string;
  registrationGrantDigest: string;
  currentSnapshotId: string | undefined;
  recoveryState: "READY" | "RECONCILING" | "MANUAL_RECOVERY_REQUIRED";
  stateVersion: number;
};

export type RunArtifactRecord = {
  role: string;
  objectDigest: ObjectDigest;
  mediaType: string;
  byteSize: number;
  classification: Classification;
  createdAt: string;
};

export type SnapshotRecord = {
  projectId: string;
  workspaceId: string;
  snapshotId: string;
  rootDigest: ObjectDigest;
  manifestDigest: ObjectDigest;
  runnerId: string;
  createdAt: string;
};

export type EnrollmentChallengeRecord = {
  challengeId: string;
  permittedProjectsDigest: string;
  expiresAt: string;
  consumedAt: string | undefined;
  createdByPrincipalId: string;
  createdAt: string;
};

export type ConsumeEnrollmentInput = {
  challengeId: string;
  consumedAt: string;
};

export type RunnerRecord = {
  runnerId: string;
  principalId: string;
  platform: string;
  revokedAt: string | undefined;
};

export type ExpireLeasesForOwnerInput = {
  owner: string;
  leaseUntil: string;
};

export type RevokeRunnerInput = {
  runnerId: string;
  reason: string;
  effectiveAt: string;
};

export type MarkOperationUnknownInput = {
  operationId: string;
  errorDigest: ObjectDigest;
  updatedAt: string;
};

export type OperationScanRow = OperationRecord & {
  projectId: string;
  leaseUntil: string | undefined;
  leaseOwner: string | undefined;
};

export type ArtifactRecord = ArtifactInput & {
  projectId: string;
};

export type StoreRuntime = {
  db: SqliteDatabase;
  hostLeaseKey: Buffer;
  dbResponseKey: Buffer;
  responseKeyId: string;
  argon2: Argon2idParameters;
  readOnly: boolean;
  closed: boolean;
  crash: CrashController;
  closeConnection: () => void;
};

export type Scoped = PrincipalScope | ProjectScope;

export type AgentNodeRecord = {
  projectId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: string;
  role: string | undefined;
  operation: string | undefined;
  agentId: string | undefined;
  leaseId: string | undefined;
  artifactDigest: string | undefined;
  idempotencyKey: string;
  updatedAt: string;
};

export type UpsertAgentNodeInput = {
  runId: string;
  nodeId: string;
  attempt: number;
  status: string;
  idempotencyKey: string;
  updatedAt: string;
  role?: string;
  operation?: string;
  agentId?: string;
  leaseId?: string;
  artifactDigest?: string;
};

export type AgentHandleRecord = {
  projectId: string;
  agentId: string;
  runId: string;
  nodeId: string;
  role: string;
  sessionId: string;
  adapter: string;
  adapterVersion: string;
  toolProfile: string;
  capabilityTokenId: string;
  leaseId: string | undefined;
  spawnedAt: string;
  lastHeartbeatAt: string;
};

export type PutAgentHandleInput = {
  agentId: string;
  runId: string;
  nodeId: string;
  role: string;
  sessionId: string;
  adapter: string;
  adapterVersion: string;
  toolProfile: string;
  capabilityTokenId: string;
  spawnedAt: string;
  lastHeartbeatAt: string;
  leaseId?: string;
};

export type AgentNodeEventRecord = {
  projectId: string;
  eventId: string;
  runId: string;
  nodeId: string;
  sequence: number;
  eventType: string;
  agentId: string | undefined;
  payloadDigest: string;
  occurredAt: string;
};

export type AppendAgentNodeEventInput = {
  eventId: string;
  runId: string;
  nodeId: string;
  sequence: number;
  eventType: string;
  payloadDigest: string;
  occurredAt: string;
  agentId?: string;
};

export type WorkspaceLeaseRecord = {
  projectId: string;
  leaseId: string;
  runId: string;
  nodeId: string;
  overlayPath: string;
  branch: string;
  baseCommit: string;
  isolationVerified: boolean;
  createdAt: string;
  expiresAt: string;
};

export type PutWorkspaceLeaseInput = {
  leaseId: string;
  runId: string;
  nodeId: string;
  overlayPath: string;
  branch: string;
  baseCommit: string;
  isolationVerified: boolean;
  createdAt: string;
  expiresAt: string;
};

export type CapabilityTokenRecord = {
  projectId: string;
  tokenId: string;
  runId: string;
  nodeId: string;
  agentId: string;
  role: string;
  mac: string;
  issuedAt: string;
  expiresAt: string;
};

export type PutCapabilityTokenInput = {
  tokenId: string;
  runId: string;
  nodeId: string;
  agentId: string;
  role: string;
  mac: string;
  issuedAt: string;
  expiresAt: string;
};
