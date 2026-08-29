import { existsSync } from "node:fs";
import path from "node:path";
import { CrashController, type CrashMode } from "./crash.js";
import {
  ARGON2ID_PRODUCTION_PARAMETERS,
  responseKeyIdFor,
  type Argon2idParameters,
} from "./crypto.js";
import { StoreClosedError, ReadOnlyRecoveryError } from "./errors.js";
import {
  defaultControlMigrationsDir,
  ensureMigrated,
  readSchemaMigration,
  type SchemaMigrationRow,
} from "./migrations.js";
import { isGcForbidden as occupancyForbidden } from "./occupancy.js";
import {
  completeApiIdempotency,
  failApiIdempotency,
  getApiIdempotency,
  markApiIdempotencyReconcileRequired,
  reserveApiIdempotency,
} from "./idempotency.js";
import {
  completeOperation,
  enqueueOperation,
  expireLeasesForOwner,
  failOperation,
  getOperation,
  heartbeatOperation,
  leaseOperation,
  listClaimableOperations,
  listOperations,
  markOperationUnknown,
  scanOperations,
} from "./operation-store.js";
import {
  bindCloudCallArtifact,
  bindOperationArtifact,
  bindSnapshotArtifact,
  completeCloudCall,
  createCloudCall,
  createSnapshot,
  getArtifact,
  getCloudCall,
  getHostAuthorityArtifact,
  getSnapshot,
  hasArtifact,
  listCloudTransportAttempts,
  listRunArtifacts,
  putArtifact,
  putHostAuthorityArtifact,
  recordCloudTransportAttempt,
  settleCloudCallTransport,
  transitionPreparedCloudCallToDispatching,
} from "./repositories/artifacts.js";
import { listRunEvents } from "./repositories/events.js";
import {
  consumeApprovalChallenge,
  consumeEnrollmentChallenge,
  createEnrollmentChallenge,
  createRunner,
  createUntrustedProject,
  createWorkspace,
  getApproval,
  getEnrollmentChallenge,
  getProject,
  getRunner,
  getRunnerByPrincipalId,
  getRunnerPrincipalId,
  getWorkspace,
  grantRunnerProject,
  insertOpenApprovalChallenge,
  insertRunnerCertificate,
  isRunnerCertificateRevoked,
  listProjects,
  listRunnerProjectGrants,
  lookupRunnerCertificate,
  lookupRunnerCertificateBySerial,
  revokeRunner,
  revokeRunnerProjectGrant,
  setProjectTrust,
  updateProjectPolicy,
  verifyEnrollmentSecret,
} from "./repositories/projects.js";
import { createRun, getRun, persistRunEvent } from "./repositories/runs.js";
import { appendUsage, getUsage, listCloudCallOutcomes, listUsageEntries } from "./repositories/usage.js";
import { toProjectScope as deriveProjectScope } from "./scope.js";
import {
  applyRuntimePragmas,
  openSqliteFile,
  readRuntimePragmas,
  type SqlitePragmas,
} from "./sqlite.js";
import type {
  ArtifactInput,
  CloudCallBindingInput,
  CloudCallRecord,
  CompleteCloudCallInput,
  CompleteIdempotencyInput,
  CompleteOperationInput,
  ConsumeApprovalInput,
  ConsumeEnrollmentInput,
  CreateCloudCallInput,
  CreateProjectInput,
  CreateRunInput,
  CreateRunnerInput,
  CreateSnapshotInput,
  CreateWorkspaceInput,
  EnqueueOperationInput,
  EnrollmentInput,
  FailOperationInput,
  GrantRunnerInput,
  RevokeRunnerGrantInput,
  RevokeRunnerInput,
  HeartbeatInput,
  HostAuthorityArtifactInput,
  InsertRunnerCertificateInput,
  LeaseOperationInput,
  MarkOperationUnknownInput,
  OpenApprovalChallengeInput,
  OperationBindingInput,
  PersistRunEventInput,
  RecordCloudTransportAttemptInput,
  RoleBindingInput,
  ReserveIdempotencyInput,
  SetProjectTrustInput,
  SettleCloudCallTransportInput,
  StoreRuntime,
  TransitionCloudCallToDispatchingInput,
  UpdateProjectPolicyInput,
  UsageInput,
} from "./types.js";
import type { ObjectDigest, PrincipalScope, ProjectScope } from "@pi-hec/domain";

export const READ_ONLY_RECOVERY_MARKER = "READ_ONLY_RECOVERY";

export function readOnlyRecoveryMarkerPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), READ_ONLY_RECOVERY_MARKER);
}

export type OpenStateStoreOptions = {
  dbPath: string;
  hostLeaseKey: Uint8Array;
  dbResponseKey: Uint8Array;
  migrationsDir?: string;
  argon2?: Argon2idParameters;
  appliedAt?: string;
  readOnlyRecovery?: boolean;
};

function requireKey(name: string, value: Uint8Array): Buffer {
  if (value.byteLength !== 32) {
    throw new Error(`${name} must be 32 bytes`);
  }
  return Buffer.from(value);
}

export class StateStore {
  readonly #runtime: StoreRuntime;
  readonly #migrationsDir: string;

  constructor(runtime: StoreRuntime, migrationsDir: string) {
    this.#runtime = runtime;
    this.#migrationsDir = migrationsDir;
  }

  get readOnlyRecovery(): boolean {
    return this.#runtime.readOnly;
  }

  isReadOnlyRecovery(): boolean {
    return this.#runtime.readOnly;
  }

  readPragmas(): SqlitePragmas {
    this.#assertOpen();
    return readRuntimePragmas(this.#runtime.db);
  }

  schemaMigration(): SchemaMigrationRow {
    this.#assertOpen();
    const row = readSchemaMigration(this.#runtime.db);
    if (row === undefined) {
      throw new Error("schema_migrations row missing");
    }
    return row;
  }

  requestCrash(method: string, mode: CrashMode): void {
    this.#runtime.crash.request(method, mode);
  }

  toProjectScope(scope: PrincipalScope, projectId: string): ProjectScope {
    return deriveProjectScope(scope, projectId);
  }

  close(): void {
    this.#runtime.closeConnection();
  }

  async backup(destinationPath: string): Promise<void> {
    this.#assertOpen();
    await this.#runtime.db.backup(destinationPath);
  }

  vacuumInto(destinationPath: string): void {
    this.#assertOpen();
    if (this.#runtime.readOnly) {
      throw new ReadOnlyRecoveryError();
    }
    const escaped = destinationPath.replaceAll("'", "''");
    this.#runtime.db.exec(`VACUUM INTO '${escaped}'`);
  }

  putHostAuthorityArtifact(input: HostAuthorityArtifactInput): void {
    putHostAuthorityArtifact(this.#runtime, input);
  }

  getHostAuthorityArtifact(objectDigest: string) {
    return getHostAuthorityArtifact(this.#runtime, objectDigest);
  }

  putArtifact(scope: ProjectScope, input: ArtifactInput): void {
    putArtifact(this.#runtime, scope, input);
  }

  createUntrustedProject(scope: PrincipalScope, input: CreateProjectInput): void {
    createUntrustedProject(this.#runtime, scope, input);
  }

  setProjectTrust(scope: PrincipalScope, input: SetProjectTrustInput): void {
    setProjectTrust(this.#runtime, scope, input);
  }

  getProject(scope: PrincipalScope, projectId: string) {
    return getProject(this.#runtime, scope, projectId);
  }

  createRunner(scope: PrincipalScope, input: CreateRunnerInput): void {
    createRunner(this.#runtime, scope, input);
  }

  grantRunnerProject(scope: ProjectScope, input: GrantRunnerInput): void {
    grantRunnerProject(this.#runtime, scope, input);
  }

  revokeRunnerProjectGrant(scope: ProjectScope, input: RevokeRunnerGrantInput): void {
    revokeRunnerProjectGrant(this.#runtime, scope, input);
  }

  createEnrollmentChallenge(scope: PrincipalScope, input: EnrollmentInput): Promise<void> {
    return createEnrollmentChallenge(this.#runtime, scope, input);
  }

  verifyEnrollmentSecret(challengeId: string, secret: Uint8Array): Promise<boolean> {
    return verifyEnrollmentSecret(this.#runtime, challengeId, secret);
  }

  createWorkspace(scope: ProjectScope, input: CreateWorkspaceInput): void {
    createWorkspace(this.#runtime, scope, input);
  }

  createSnapshot(scope: ProjectScope, input: CreateSnapshotInput): void {
    createSnapshot(this.#runtime, scope, input);
  }

  bindSnapshotArtifact(scope: ProjectScope, input: RoleBindingInput): void {
    bindSnapshotArtifact(this.#runtime, scope, input);
  }

  createRun(scope: ProjectScope, input: CreateRunInput) {
    return createRun(this.#runtime, scope, input);
  }

  getRun(scope: ProjectScope, runId: string) {
    return getRun(this.#runtime, scope, runId);
  }

  persistRunEvent(scope: ProjectScope, input: PersistRunEventInput) {
    return persistRunEvent(this.#runtime, scope, input);
  }

  listRunEvents(scope: ProjectScope, runId: string) {
    return listRunEvents(this.#runtime, scope, runId);
  }

  enqueueOperation(scope: ProjectScope, input: EnqueueOperationInput) {
    return enqueueOperation(this.#runtime, scope, input);
  }

  getOperation(scope: ProjectScope, operationId: string) {
    return getOperation(this.#runtime, scope, operationId);
  }

  leaseOperation(scope: ProjectScope, input: LeaseOperationInput) {
    return leaseOperation(this.#runtime, scope, input);
  }

  heartbeatOperation(scope: ProjectScope, input: HeartbeatInput): void {
    heartbeatOperation(this.#runtime, scope, input);
  }

  completeOperation(scope: ProjectScope, input: CompleteOperationInput) {
    return completeOperation(this.#runtime, scope, input);
  }

  failOperation(scope: ProjectScope, input: FailOperationInput) {
    return failOperation(this.#runtime, scope, input);
  }

  reserveApiIdempotency(scope: PrincipalScope, input: ReserveIdempotencyInput) {
    return reserveApiIdempotency(this.#runtime, scope, input);
  }

  completeApiIdempotency(scope: PrincipalScope, input: CompleteIdempotencyInput): void {
    completeApiIdempotency(this.#runtime, scope, input);
  }

  failApiIdempotency(scope: PrincipalScope, input: CompleteIdempotencyInput): void {
    failApiIdempotency(this.#runtime, scope, input);
  }

  markApiIdempotencyReconcileRequired(
    scope: PrincipalScope,
    input: { operationId: string; updatedAt: string },
  ): void {
    markApiIdempotencyReconcileRequired(this.#runtime, scope, input);
  }

  getApiIdempotency(scope: PrincipalScope, operationId: string) {
    return getApiIdempotency(this.#runtime, scope, operationId);
  }

  createCloudCall(scope: ProjectScope, input: CreateCloudCallInput): void {
    createCloudCall(this.#runtime, scope, input);
  }

  bindCloudCallArtifact(scope: ProjectScope, input: CloudCallBindingInput): void {
    bindCloudCallArtifact(this.#runtime, scope, input);
  }

  getCloudCall(scope: ProjectScope, cloudCallId: string): CloudCallRecord | undefined {
    return getCloudCall(this.#runtime, scope, cloudCallId);
  }

  transitionPreparedCloudCallToDispatching(
    scope: ProjectScope,
    input: TransitionCloudCallToDispatchingInput,
  ): boolean {
    return transitionPreparedCloudCallToDispatching(this.#runtime, scope, input);
  }

  completeCloudCall(scope: ProjectScope, input: CompleteCloudCallInput): void {
    completeCloudCall(this.#runtime, scope, input);
  }

  getArtifact(scope: ProjectScope, digest: ObjectDigest) {
    return getArtifact(this.#runtime, scope, digest);
  }

  listCloudTransportAttempts(scope: ProjectScope, cloudCallId: string) {
    return listCloudTransportAttempts(this.#runtime, scope, cloudCallId);
  }

  recordCloudTransportAttempt(scope: ProjectScope, input: RecordCloudTransportAttemptInput): void {
    recordCloudTransportAttempt(this.#runtime, scope, input);
  }

  settleCloudCallTransport(scope: ProjectScope, input: SettleCloudCallTransportInput): void {
    settleCloudCallTransport(this.#runtime, scope, input);
  }

  bindOperationArtifact(scope: ProjectScope, input: OperationBindingInput): void {
    bindOperationArtifact(this.#runtime, scope, input);
  }

  appendUsage(scope: ProjectScope, input: UsageInput): void {
    appendUsage(this.#runtime, scope, input);
  }

  getUsage(scope: ProjectScope, usageEntryId: string) {
    return getUsage(this.#runtime, scope, usageEntryId);
  }

  listUsageEntries(scope: ProjectScope) {
    return listUsageEntries(this.#runtime, scope);
  }

  listCloudCallOutcomes(scope: ProjectScope) {
    return listCloudCallOutcomes(this.#runtime, scope);
  }

  getApproval(scope: ProjectScope, approvalId: string) {
    return getApproval(this.#runtime, scope, approvalId);
  }

  listProjects(scope: PrincipalScope) {
    return listProjects(this.#runtime, scope);
  }

  getWorkspace(scope: ProjectScope, workspaceId: string) {
    return getWorkspace(this.#runtime, scope, workspaceId);
  }

  hasArtifact(scope: ProjectScope, digest: ObjectDigest) {
    return hasArtifact(this.#runtime, scope, digest);
  }

  getSnapshot(scope: ProjectScope, snapshotId: string) {
    return getSnapshot(this.#runtime, scope, snapshotId);
  }

  listRunArtifacts(scope: ProjectScope, runId: string) {
    return listRunArtifacts(this.#runtime, scope, runId);
  }

  listOperations(scope: ProjectScope) {
    return listOperations(this.#runtime, scope);
  }

  scanOperations() {
    return scanOperations(this.#runtime);
  }

  listClaimableOperations(projectIds: readonly string[], now: string) {
    return listClaimableOperations(this.#runtime, projectIds, now);
  }

  markOperationUnknown(scope: ProjectScope, input: MarkOperationUnknownInput) {
    return markOperationUnknown(this.#runtime, scope, input);
  }

  expireLeasesForOwner(input: { owner: string; leaseUntil: string }): void {
    expireLeasesForOwner(this.#runtime, input);
  }

  insertRunnerCertificate(scope: PrincipalScope, input: InsertRunnerCertificateInput): void {
    insertRunnerCertificate(this.#runtime, scope, input);
  }

  lookupRunnerCertificate(serial: string, spkiSha256: string) {
    return lookupRunnerCertificate(this.#runtime, serial, spkiSha256);
  }

  lookupRunnerCertificateBySerial(serial: string) {
    return lookupRunnerCertificateBySerial(this.#runtime, serial);
  }

  isRunnerCertificateRevoked(serial: string, spkiSha256: string): boolean {
    return isRunnerCertificateRevoked(this.#runtime, serial, spkiSha256);
  }

  getRunner(runnerId: string) {
    return getRunner(this.#runtime, runnerId);
  }

  getRunnerByPrincipalId(principalId: string) {
    return getRunnerByPrincipalId(this.#runtime, principalId);
  }

  getRunnerPrincipalId(runnerId: string) {
    return getRunnerPrincipalId(this.#runtime, runnerId);
  }

  listRunnerProjectGrants(runnerId: string) {
    return listRunnerProjectGrants(this.#runtime, runnerId);
  }

  getEnrollmentChallenge(challengeId: string) {
    return getEnrollmentChallenge(this.#runtime, challengeId);
  }

  consumeEnrollmentChallenge(input: ConsumeEnrollmentInput): void {
    consumeEnrollmentChallenge(this.#runtime, input);
  }

  revokeRunner(scope: PrincipalScope, input: RevokeRunnerInput): void {
    revokeRunner(this.#runtime, scope, input);
  }

  insertOpenApprovalChallenge(scope: ProjectScope, input: OpenApprovalChallengeInput): void {
    insertOpenApprovalChallenge(this.#runtime, scope, input);
  }

  consumeApprovalChallenge(scope: ProjectScope, input: ConsumeApprovalInput): void {
    consumeApprovalChallenge(this.#runtime, scope, input);
  }

  updateProjectPolicy(scope: PrincipalScope, input: UpdateProjectPolicyInput) {
    return updateProjectPolicy(this.#runtime, scope, input);
  }

  isGcForbidden(scope: ProjectScope, objectDigest: ObjectDigest): boolean {
    this.#assertOpen();
    return occupancyForbidden(this.#runtime, scope, objectDigest);
  }

  migrationsDir(): string {
    return this.#migrationsDir;
  }

  #assertOpen(): void {
    if (this.#runtime.closed) {
      throw new StoreClosedError();
    }
  }
}

export function openStateStore(options: OpenStateStoreOptions): StateStore {
  const hostLeaseKey = requireKey("hostLeaseKey", options.hostLeaseKey);
  const dbResponseKey = requireKey("dbResponseKey", options.dbResponseKey);
  const migrationsDir = options.migrationsDir ?? defaultControlMigrationsDir();
  const db = openSqliteFile(options.dbPath);
  applyRuntimePragmas(db);
  const appliedAt = options.appliedAt ?? new Date().toISOString();
  const migrated = ensureMigrated(db, migrationsDir, appliedAt);
  applyRuntimePragmas(db);
  const runtime: StoreRuntime = {
    db,
    hostLeaseKey,
    dbResponseKey,
    responseKeyId: responseKeyIdFor(dbResponseKey),
    argon2: options.argon2 ?? ARGON2ID_PRODUCTION_PARAMETERS,
    readOnly:
      options.readOnlyRecovery === true ||
      existsSync(readOnlyRecoveryMarkerPath(options.dbPath)) ||
      migrated.readOnly,
    closed: false,
    crash: new CrashController(),
    closeConnection: () => {
      if (!runtime.closed) {
        runtime.db.close();
        runtime.closed = true;
      }
    },
  };
  return new StateStore(runtime, migrationsDir);
}

export type { CrashMode, SqlitePragmas };
