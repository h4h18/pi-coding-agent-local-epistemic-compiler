import type { ObjectDigest, ProjectScope } from "@pi-hec/domain";
import { executeWrite } from "../crash.js";
import { StoreLookupError } from "../errors.js";
import { optionalInt, optionalString, requiredInt, requiredString, rowOf } from "../rows.js";
import { scopedProjectId } from "../scope.js";
import type {
  ArtifactInput,
  ArtifactRecord,
  CloudCallBindingInput,
  CloudCallRecord,
  CloudTransportAttemptRecord,
  CompleteCloudCallInput,
  CreateCloudCallInput,
  CreateSnapshotInput,
  HostAuthorityArtifactInput,
  OperationBindingInput,
  RecordCloudTransportAttemptInput,
  RoleBindingInput,
  RunArtifactRecord,
  SettleCloudCallTransportInput,
  SnapshotRecord,
  StoreRuntime,
  TransitionCloudCallToDispatchingInput,
} from "../types.js";

export function insertHostAuthorityArtifactRow(
  runtime: StoreRuntime,
  input: HostAuthorityArtifactInput,
): void {
  runtime.db
    .prepare(
      `INSERT INTO host_authority_artifacts(
        object_digest, schema_name, media_type, byte_size, encryption_key_id, encryption_nonce,
        signature_key_id, signature, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.objectDigest,
      input.schemaName,
      input.mediaType,
      input.byteSize,
      input.encryptionKeyId,
      input.encryptionNonce,
      input.signatureKeyId,
      input.signature,
      input.createdAt,
    );
}

export function insertArtifactRow(
  runtime: StoreRuntime,
  projectId: string,
  input: ArtifactInput,
): void {
  runtime.db
    .prepare(
      `INSERT INTO artifacts(
        project_id, digest, schema_name, media_type, byte_size, classification,
        encryption_algorithm, encryption_key_id, encryption_nonce, storage_record_digest,
        storage_record_signing_key_id, storage_record_signature_algorithm, storage_record_signed_at,
        storage_record_signer_certificate_digest, storage_record_signature, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      input.digest,
      input.schemaName,
      input.mediaType,
      input.byteSize,
      input.classification,
      input.encryptionAlgorithm,
      input.encryptionKeyId,
      input.encryptionNonce,
      input.storageRecordDigest,
      input.storageRecordSigningKeyId,
      input.storageRecordSignatureAlgorithm,
      input.storageRecordSignedAt,
      input.storageRecordSignerCertificateDigest,
      input.storageRecordSignature,
      input.createdAt,
    );
}

export function putHostAuthorityArtifact(runtime: StoreRuntime, input: HostAuthorityArtifactInput): void {
  executeWrite(runtime, "putHostAuthorityArtifact", () => {
    insertHostAuthorityArtifactRow(runtime, input);
  });
}

export function getHostAuthorityArtifact(
  runtime: StoreRuntime,
  objectDigest: string,
): HostAuthorityArtifactInput | undefined {
  const row = runtime.db
    .prepare(
      `SELECT object_digest, schema_name, media_type, byte_size, encryption_key_id, encryption_nonce,
              signature_key_id, signature, created_at
       FROM host_authority_artifacts WHERE object_digest = ?`,
    )
    .get(objectDigest);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "host_authority_artifacts");
  return {
    objectDigest: requiredString(record, "object_digest"),
    schemaName: requiredString(record, "schema_name"),
    mediaType: requiredString(record, "media_type"),
    byteSize: requiredInt(record, "byte_size"),
    encryptionKeyId: requiredString(record, "encryption_key_id"),
    encryptionNonce: requiredString(record, "encryption_nonce"),
    signatureKeyId: requiredString(record, "signature_key_id"),
    signature: requiredString(record, "signature"),
    createdAt: requiredString(record, "created_at"),
  };
}

export function putArtifact(runtime: StoreRuntime, scope: ProjectScope, input: ArtifactInput): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "putArtifact", () => {
    insertArtifactRow(runtime, projectId, input);
  });
}

export function createSnapshot(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: CreateSnapshotInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "createSnapshot", () => {
    runtime.db
      .prepare(
        `INSERT INTO snapshots(
          project_id, snapshot_id, workspace_id, root_digest, manifest_digest, runner_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        input.snapshotId,
        input.workspaceId,
        input.rootDigest,
        input.manifestDigest,
        input.runnerId,
        input.createdAt,
      );
  });
}

export function bindSnapshotArtifact(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: RoleBindingInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "bindSnapshotArtifact", () => {
    runtime.db
      .prepare(
        `INSERT INTO snapshot_artifacts(project_id, snapshot_id, role, artifact_digest, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, input.snapshotId, input.role, input.artifactDigest, input.createdAt);
  });
}

export function createCloudCall(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: CreateCloudCallInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "createCloudCall", () => {
    runtime.db
      .prepare(
        `INSERT INTO cloud_calls(
          project_id, cloud_call_id, run_id, purpose, deployment_id, request_digest,
          context_packet_digest, recovery_grade, state, response_digest, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        input.cloudCallId,
        input.runId,
        input.purpose,
        input.deploymentId,
        input.requestDigest,
        input.contextPacketDigest,
        input.recoveryGrade,
        input.state,
        input.responseDigest ?? null,
        input.createdAt,
        input.createdAt,
      );
  });
}

export function bindCloudCallArtifact(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: CloudCallBindingInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "bindCloudCallArtifact", () => {
    runtime.db
      .prepare(
        `INSERT INTO cloud_call_artifacts(project_id, cloud_call_id, role, artifact_digest, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, input.cloudCallId, input.role, input.artifactDigest, input.createdAt);
  });
}

export function getCloudCall(
  runtime: StoreRuntime,
  scope: ProjectScope,
  cloudCallId: string,
): CloudCallRecord | undefined {
  const projectId = scopedProjectId(scope);
  const row = runtime.db
    .prepare(
      `SELECT cloud_call_id, run_id, purpose, deployment_id, request_digest, context_packet_digest,
              recovery_grade, state, response_digest, created_at, updated_at
       FROM cloud_calls WHERE project_id = ? AND cloud_call_id = ?`,
    )
    .get(projectId, cloudCallId);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "cloud_calls");
  const responseDigest = optionalString(record, "response_digest");
  return {
    cloudCallId: requiredString(record, "cloud_call_id"),
    runId: requiredString(record, "run_id"),
    purpose: requiredString(record, "purpose") as CloudCallRecord["purpose"],
    deploymentId: requiredString(record, "deployment_id"),
    requestDigest: requiredString(record, "request_digest") as ObjectDigest,
    contextPacketDigest: requiredString(record, "context_packet_digest") as ObjectDigest,
    recoveryGrade: requiredString(record, "recovery_grade") as CloudCallRecord["recoveryGrade"],
    state: requiredString(record, "state") as CloudCallRecord["state"],
    ...(responseDigest === undefined ? {} : { responseDigest: responseDigest as ObjectDigest }),
    createdAt: requiredString(record, "created_at"),
    updatedAt: requiredString(record, "updated_at"),
  };
}

export function transitionPreparedCloudCallToDispatching(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: TransitionCloudCallToDispatchingInput,
): boolean {
  const projectId = scopedProjectId(scope);
  return executeWrite(runtime, "transitionPreparedCloudCallToDispatching", () => {
    const updated = runtime.db
      .prepare(
        `UPDATE cloud_calls
         SET state = 'dispatching', updated_at = ?
         WHERE project_id = ? AND cloud_call_id = ? AND request_digest = ? AND state = 'prepared'`,
      )
      .run(input.updatedAt, projectId, input.cloudCallId, input.requestDigest);
    if (updated.changes !== 1) {
      return false;
    }
    void input.attemptId;
    void input.requestStartedAt;
    return true;
  });
}

export function completeCloudCall(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: CompleteCloudCallInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "completeCloudCall", () => {
    const updated = runtime.db
      .prepare(
        `UPDATE cloud_calls
         SET state = 'completed', response_digest = ?, updated_at = ?
         WHERE project_id = ? AND cloud_call_id = ? AND state IN ('dispatching', 'in-flight') AND response_digest IS NULL`,
      )
      .run(input.responseDigest, input.updatedAt, projectId, input.cloudCallId);
    if (updated.changes !== 1) {
      throw new StoreLookupError();
    }
  });
}

function nextAttemptNumber(runtime: StoreRuntime, projectId: string, cloudCallId: string): number {
  const row = runtime.db
    .prepare(
      `SELECT MAX(attempt_number) AS attempt_number
       FROM cloud_transport_attempts WHERE project_id = ? AND cloud_call_id = ?`,
    )
    .get(projectId, cloudCallId);
  if (row === undefined) {
    return 1;
  }
  const current = optionalInt(rowOf(row, "cloud_transport_attempts"), "attempt_number");
  return (current ?? 0) + 1;
}

function insertTransportAttempt(
  runtime: StoreRuntime,
  projectId: string,
  input: RecordCloudTransportAttemptInput,
): void {
  const attemptNumber = nextAttemptNumber(runtime, projectId, input.cloudCallId);
  runtime.db
    .prepare(
      `INSERT INTO cloud_transport_attempts(
        project_id, attempt_id, cloud_call_id, attempt_number, request_started_at,
        response_started_at, completed_at, outcome, provider_request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      `att_${input.cloudCallId}_${String(attemptNumber)}`,
      input.cloudCallId,
      attemptNumber,
      input.requestStartedAt,
      input.responseStartedAt ?? null,
      input.completedAt ?? null,
      input.outcome,
      input.providerRequestId ?? null,
    );
}

export function recordCloudTransportAttempt(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: RecordCloudTransportAttemptInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "recordCloudTransportAttempt", () => {
    insertTransportAttempt(runtime, projectId, input);
  });
}

export function listCloudTransportAttempts(
  runtime: StoreRuntime,
  scope: ProjectScope,
  cloudCallId: string,
): CloudTransportAttemptRecord[] {
  const projectId = scopedProjectId(scope);
  const rows = runtime.db
    .prepare(
      `SELECT attempt_id, cloud_call_id, attempt_number, request_started_at, response_started_at,
              completed_at, outcome, provider_request_id
       FROM cloud_transport_attempts
       WHERE project_id = ? AND cloud_call_id = ?
       ORDER BY attempt_number ASC`,
    )
    .all(projectId, cloudCallId);
  return rows.map((row) => {
    const record = rowOf(row, "cloud_transport_attempts");
    const responseStartedAt = optionalString(record, "response_started_at");
    const completedAt = optionalString(record, "completed_at");
    const providerRequestId = optionalString(record, "provider_request_id");
    return {
      attemptId: requiredString(record, "attempt_id"),
      cloudCallId: requiredString(record, "cloud_call_id"),
      attemptNumber: requiredInt(record, "attempt_number"),
      requestStartedAt: requiredString(record, "request_started_at"),
      outcome: requiredString(record, "outcome") as CloudTransportAttemptRecord["outcome"],
      ...(responseStartedAt === undefined ? {} : { responseStartedAt }),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
    };
  });
}

export function settleCloudCallTransport(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: SettleCloudCallTransportInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "settleCloudCallTransport", () => {
    insertTransportAttempt(runtime, projectId, {
      cloudCallId: input.cloudCallId,
      requestStartedAt: input.requestStartedAt,
      outcome: input.attemptOutcome,
      completedAt: input.updatedAt,
    });
    const updated = runtime.db
      .prepare(
        `UPDATE cloud_calls
         SET state = ?, updated_at = ?
         WHERE project_id = ? AND cloud_call_id = ? AND state IN ('dispatching', 'in-flight') AND response_digest IS NULL`,
      )
      .run(input.nextState, input.updatedAt, projectId, input.cloudCallId);
    if (updated.changes !== 1) {
      throw new StoreLookupError();
    }
  });
}

export function bindOperationArtifact(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: OperationBindingInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "bindOperationArtifact", () => {
    runtime.db
      .prepare(
        `INSERT INTO operation_artifacts(project_id, operation_id, role, artifact_digest, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, input.operationId, input.role, input.artifactDigest, input.createdAt);
  });
}

export function artifactExists(runtime: StoreRuntime, projectId: string, digest: ObjectDigest): boolean {
  const row = runtime.db
    .prepare("SELECT 1 AS ok FROM artifacts WHERE project_id = ? AND digest = ?")
    .get(projectId, digest);
  return row !== undefined;
}

export function hasArtifact(runtime: StoreRuntime, scope: ProjectScope, digest: ObjectDigest): boolean {
  return artifactExists(runtime, scopedProjectId(scope), digest);
}

export function getArtifact(
  runtime: StoreRuntime,
  scope: ProjectScope,
  digest: ObjectDigest,
): ArtifactRecord | undefined {
  const projectId = scopedProjectId(scope);
  const row = runtime.db
    .prepare(
      `SELECT project_id, digest, schema_name, media_type, byte_size, classification, encryption_algorithm,
              encryption_key_id, encryption_nonce, storage_record_digest, storage_record_signing_key_id,
              storage_record_signature_algorithm, storage_record_signed_at,
              storage_record_signer_certificate_digest, storage_record_signature, created_at
       FROM artifacts WHERE project_id = ? AND digest = ?`,
    )
    .get(projectId, digest);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "artifacts");
  return {
    projectId: requiredString(record, "project_id"),
    digest: requiredString(record, "digest") as ObjectDigest,
    schemaName: optionalString(record, "schema_name") ?? null,
    mediaType: requiredString(record, "media_type"),
    byteSize: requiredInt(record, "byte_size"),
    classification: requiredString(record, "classification") as ArtifactRecord["classification"],
    encryptionAlgorithm: requiredString(record, "encryption_algorithm") as ArtifactRecord["encryptionAlgorithm"],
    encryptionKeyId: requiredString(record, "encryption_key_id"),
    encryptionNonce: requiredString(record, "encryption_nonce"),
    storageRecordDigest: requiredString(record, "storage_record_digest"),
    storageRecordSigningKeyId: requiredString(record, "storage_record_signing_key_id"),
    storageRecordSignatureAlgorithm: requiredString(
      record,
      "storage_record_signature_algorithm",
    ) as ArtifactRecord["storageRecordSignatureAlgorithm"],
    storageRecordSignedAt: requiredString(record, "storage_record_signed_at"),
    storageRecordSignerCertificateDigest: requiredString(record, "storage_record_signer_certificate_digest"),
    storageRecordSignature: requiredString(record, "storage_record_signature"),
    createdAt: requiredString(record, "created_at"),
  };
}

export function getSnapshot(
  runtime: StoreRuntime,
  scope: ProjectScope,
  snapshotId: string,
): SnapshotRecord {
  const projectId = scopedProjectId(scope);
  const row = runtime.db
    .prepare(
      `SELECT project_id, workspace_id, snapshot_id, root_digest, manifest_digest, runner_id, created_at
       FROM snapshots WHERE project_id = ? AND snapshot_id = ?`,
    )
    .get(projectId, snapshotId);
  if (row === undefined) {
    throw new StoreLookupError();
  }
  const record = rowOf(row, "snapshots");
  return {
    projectId: requiredString(record, "project_id"),
    workspaceId: requiredString(record, "workspace_id"),
    snapshotId: requiredString(record, "snapshot_id"),
    rootDigest: requiredString(record, "root_digest") as ObjectDigest,
    manifestDigest: requiredString(record, "manifest_digest") as ObjectDigest,
    runnerId: requiredString(record, "runner_id"),
    createdAt: requiredString(record, "created_at"),
  };
}

export function listRunArtifacts(
  runtime: StoreRuntime,
  scope: ProjectScope,
  runId: string,
): RunArtifactRecord[] {
  const projectId = scopedProjectId(scope);
  const rows = runtime.db
    .prepare(
      `SELECT ra.role AS role, ra.artifact_digest AS digest, a.media_type AS media_type,
              a.byte_size AS byte_size, a.classification AS classification, a.created_at AS created_at
       FROM run_artifacts ra
       JOIN artifacts a ON a.project_id = ra.project_id AND a.digest = ra.artifact_digest
       WHERE ra.project_id = ? AND ra.run_id = ?
       ORDER BY ra.role, ra.artifact_digest`,
    )
    .all(projectId, runId);
  return rows.map((row) => {
    const record = rowOf(row, "run-artifacts-join");
    const classification = requiredString(record, "classification");
    if (
      classification !== "public" &&
      classification !== "internal" &&
      classification !== "confidential" &&
      classification !== "restricted"
    ) {
      throw new Error("invalid classification");
    }
    return {
      role: requiredString(record, "role"),
      objectDigest: requiredString(record, "digest") as ObjectDigest,
      mediaType: requiredString(record, "media_type"),
      byteSize: requiredInt(record, "byte_size"),
      classification,
      createdAt: requiredString(record, "created_at"),
    };
  });
}
