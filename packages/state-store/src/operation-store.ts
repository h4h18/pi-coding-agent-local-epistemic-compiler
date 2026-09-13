import { OPERATION_KINDS, RECLAIMABLE_OPERATION_KINDS, type ProjectScope } from "@pi-hec/domain";
import { executeWrite } from "./crash.js";
import { generateLeaseToken, leaseTokenHashHex, verifyLeaseToken } from "./crypto.js";
import { ConflictError, LeaseError, StoreLookupError } from "./errors.js";
import { optionalString, requiredInt, requiredString, rowOf } from "./rows.js";
import { scopedProjectId } from "./scope.js";
import { artifactExists } from "./repositories/artifacts.js";
import { loadRunProjection } from "./repositories/runs.js";
import type {
  CompleteOperationInput,
  EnqueueOperationInput,
  FailOperationInput,
  HeartbeatInput,
  LeaseOperationInput,
  LeaseResult,
  MarkOperationUnknownInput,
  OperationRecord,
  OperationScanRow,
  StoreRuntime,
} from "./types.js";

const KIND_SET: ReadonlySet<string> = new Set(OPERATION_KINDS);

function decodeToken(token: string): Buffer {
  return Buffer.from(token, "base64url");
}

function readOperation(
  runtime: StoreRuntime,
  projectId: string,
  operationId: string,
): OperationRecord | undefined {
  const row = runtime.db
    .prepare(
      `SELECT operation_id, run_id, operation_kind, dedupe_key, input_digest, state, reclaimable,
              lease_generation, lease_owner, result_digest, error_digest, created_at, updated_at
       FROM operations WHERE project_id = ? AND operation_id = ?`,
    )
    .get(projectId, operationId);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "operations");
  return {
    operationId: requiredString(record, "operation_id"),
    runId: requiredString(record, "run_id"),
    operationKind: requiredString(record, "operation_kind"),
    dedupeKey: requiredString(record, "dedupe_key"),
    inputDigest: requiredString(record, "input_digest"),
    state: requiredString(record, "state"),
    reclaimable: requiredInt(record, "reclaimable") === 1,
    leaseGeneration: requiredInt(record, "lease_generation"),
    leaseOwner: optionalString(record, "lease_owner"),
    resultDigest: optionalString(record, "result_digest"),
    errorDigest: optionalString(record, "error_digest"),
    createdAt: requiredString(record, "created_at"),
    updatedAt: requiredString(record, "updated_at"),
  };
}

function leaseRow(
  runtime: StoreRuntime,
  projectId: string,
  operationId: string,
): Record<string, unknown> | undefined {
  const row = runtime.db
    .prepare(
      `SELECT operation_id, run_id, operation_kind, input_digest, state, reclaimable, lease_generation,
              lease_owner, lease_until, lease_token_hash
       FROM operations WHERE project_id = ? AND operation_id = ?`,
    )
    .get(projectId, operationId);
  if (row === undefined) {
    return undefined;
  }
  return rowOf(row, "operations-lease");
}

export function enqueueOperation(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: EnqueueOperationInput,
): OperationRecord {
  const projectId = scopedProjectId(scope);
  if (!KIND_SET.has(input.operationKind)) {
    throw new Error(`unhandled union: ${JSON.stringify(input.operationKind)}`);
  }
  const reclaimable = RECLAIMABLE_OPERATION_KINDS.has(
    input.operationKind as (typeof OPERATION_KINDS)[number],
  )
    ? 1
    : 0;
  return executeWrite(runtime, "enqueueOperation", () => {
    if (loadRunProjection(runtime, projectId, input.runId) === undefined) {
      throw new StoreLookupError();
    }
    if (!artifactExists(runtime, projectId, input.inputDigest)) {
      throw new StoreLookupError();
    }
    const existing = readOperation(runtime, projectId, input.operationId);
    if (existing !== undefined) {
      if (existing.inputDigest !== input.inputDigest) {
        throw new ConflictError(
          "OPERATION_INPUT_CONFLICT",
          "operation id reused with a different input",
        );
      }
      return existing;
    }
    const dedupe = runtime.db
      .prepare(
        `SELECT operation_id, input_digest FROM operations
         WHERE project_id = ? AND run_id = ? AND dedupe_key = ?`,
      )
      .get(projectId, input.runId, input.dedupeKey);
    if (dedupe !== undefined) {
      const record = rowOf(dedupe, "operation-dedupe");
      if (requiredString(record, "input_digest") === input.inputDigest) {
        const found = readOperation(runtime, projectId, requiredString(record, "operation_id"));
        if (found === undefined) {
          throw new StoreLookupError();
        }
        return found;
      }
      throw new ConflictError(
        "OPERATION_DEDUPE_CONFLICT",
        "dedupe key reused with a different input",
      );
    }
    runtime.db
      .prepare(
        `INSERT INTO operations(
          project_id, operation_id, run_id, operation_kind, dedupe_key, input_digest, state,
          reclaimable, lease_generation, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, 0, ?, ?)`,
      )
      .run(
        projectId,
        input.operationId,
        input.runId,
        input.operationKind,
        input.dedupeKey,
        input.inputDigest,
        reclaimable,
        input.createdAt,
        input.createdAt,
      );
    const created = readOperation(runtime, projectId, input.operationId);
    if (created === undefined) {
      throw new StoreLookupError();
    }
    return created;
  });
}

export function getOperation(
  runtime: StoreRuntime,
  scope: ProjectScope,
  operationId: string,
): OperationRecord {
  const projectId = scopedProjectId(scope);
  const row = readOperation(runtime, projectId, operationId);
  if (row === undefined) {
    throw new StoreLookupError();
  }
  return row;
}

function assertLiveLease(
  runtime: StoreRuntime,
  row: Record<string, unknown>,
  token: string,
  owner: string,
  now: string,
): void {
  const state = requiredString(row, "state");
  if (state !== "leased") {
    throw new LeaseError("operation is not leased");
  }
  const until = optionalString(row, "lease_until");
  if (until === undefined || now > until) {
    throw new LeaseError("lease expired");
  }
  const storedOwner = optionalString(row, "lease_owner");
  if (storedOwner !== owner) {
    throw new LeaseError("lease owner mismatch");
  }
  const storedHash = optionalString(row, "lease_token_hash");
  if (
    storedHash === undefined ||
    !verifyLeaseToken(runtime.hostLeaseKey, decodeToken(token), storedHash)
  ) {
    throw new LeaseError("lease token mismatch");
  }
}

function assertLeaseGeneration(row: Record<string, unknown>, expected: number | undefined): void {
  if (expected === undefined) {
    return;
  }
  if (requiredInt(row, "lease_generation") !== expected) {
    throw new LeaseError("lease generation mismatch");
  }
}

function assertObservedInput(row: Record<string, unknown>, observed: string | undefined): void {
  if (observed === undefined) {
    return;
  }
  if (requiredString(row, "input_digest") !== observed) {
    throw new LeaseError("observed input digest mismatch");
  }
}

export function leaseOperation(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: LeaseOperationInput,
): LeaseResult {
  const projectId = scopedProjectId(scope);
  return executeWrite(runtime, "leaseOperation", () => {
    const row = leaseRow(runtime, projectId, input.operationId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    const state = requiredString(row, "state");
    const reclaimable = requiredInt(row, "reclaimable") === 1;
    if (state === "succeeded" || state === "cancelled") {
      throw new LeaseError("terminal operation cannot be leased");
    }
    if (!reclaimable && state !== "ready") {
      throw new LeaseError("non-reclaimable operation cannot be re-leased");
    }
    if (state === "leased") {
      const until = optionalString(row, "lease_until");
      if (!reclaimable || until === undefined || input.now <= until) {
        throw new LeaseError("active lease cannot be stolen");
      }
    } else if (state !== "ready" && state !== "failed" && state !== "unknown") {
      throw new LeaseError("operation is not claimable");
    } else if ((state === "failed" || state === "unknown") && !reclaimable) {
      throw new LeaseError("non-reclaimable operation cannot be re-leased");
    }
    const token = generateLeaseToken();
    const generation = requiredInt(row, "lease_generation") + 1;
    const hash = leaseTokenHashHex(runtime.hostLeaseKey, token);
    runtime.db
      .prepare(
        `UPDATE operations
         SET state = 'leased',
             lease_generation = ?,
             lease_owner = ?,
             lease_until = ?,
             lease_token_hash = ?,
             result_digest = NULL,
             error_digest = NULL,
             updated_at = ?
         WHERE project_id = ? AND operation_id = ?`,
      )
      .run(
        generation,
        input.owner,
        input.leaseUntil,
        hash,
        input.now,
        projectId,
        input.operationId,
      );
    return { token: token.toString("base64url"), generation, leaseUntil: input.leaseUntil };
  });
}

export function heartbeatOperation(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: HeartbeatInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "heartbeatOperation", () => {
    const row = leaseRow(runtime, projectId, input.operationId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    assertLiveLease(runtime, row, input.token, input.owner, input.now);
    assertLeaseGeneration(row, input.leaseGeneration);
    assertObservedInput(row, input.observedInputDigest);
    runtime.db
      .prepare(
        `UPDATE operations SET lease_until = ?, updated_at = ?
         WHERE project_id = ? AND operation_id = ? AND lease_generation = ?`,
      )
      .run(
        input.leaseUntil,
        input.now,
        projectId,
        input.operationId,
        requiredInt(row, "lease_generation"),
      );
  });
}

export function completeOperation(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: CompleteOperationInput,
): OperationRecord {
  const projectId = scopedProjectId(scope);
  return executeWrite(runtime, "completeOperation", () => {
    const row = leaseRow(runtime, projectId, input.operationId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    assertLiveLease(runtime, row, input.token, input.owner, input.now);
    assertLeaseGeneration(row, input.leaseGeneration);
    if (!artifactExists(runtime, projectId, input.resultDigest)) {
      throw new StoreLookupError();
    }
    runtime.db
      .prepare(
        `UPDATE operations
         SET state = 'succeeded',
             lease_owner = NULL,
             lease_until = NULL,
             lease_token_hash = NULL,
             result_digest = ?,
             error_digest = NULL,
             updated_at = ?
         WHERE project_id = ? AND operation_id = ? AND lease_generation = ? AND input_digest = ?`,
      )
      .run(
        input.resultDigest,
        input.updatedAt,
        projectId,
        input.operationId,
        requiredInt(row, "lease_generation"),
        requiredString(row, "input_digest"),
      );
    const done = readOperation(runtime, projectId, input.operationId);
    if (done === undefined) {
      throw new StoreLookupError();
    }
    return done;
  });
}

export function failOperation(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: FailOperationInput,
): OperationRecord {
  const projectId = scopedProjectId(scope);
  return executeWrite(runtime, "failOperation", () => {
    const row = leaseRow(runtime, projectId, input.operationId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    assertLiveLease(runtime, row, input.token, input.owner, input.now);
    assertLeaseGeneration(row, input.leaseGeneration);
    if (!artifactExists(runtime, projectId, input.errorDigest)) {
      throw new StoreLookupError();
    }
    runtime.db
      .prepare(
        `UPDATE operations
         SET state = 'failed',
             lease_owner = NULL,
             lease_until = NULL,
             lease_token_hash = NULL,
             result_digest = NULL,
             error_digest = ?,
             updated_at = ?
         WHERE project_id = ? AND operation_id = ? AND lease_generation = ?`,
      )
      .run(
        input.errorDigest,
        input.updatedAt,
        projectId,
        input.operationId,
        requiredInt(row, "lease_generation"),
      );
    const done = readOperation(runtime, projectId, input.operationId);
    if (done === undefined) {
      throw new StoreLookupError();
    }
    return done;
  });
}

export function listOperations(runtime: StoreRuntime, scope: ProjectScope): OperationRecord[] {
  const projectId = scopedProjectId(scope);
  const rows = runtime.db
    .prepare(
      `SELECT operation_id, run_id, operation_kind, dedupe_key, input_digest, state, reclaimable,
              lease_generation, lease_owner, result_digest, error_digest, created_at, updated_at
       FROM operations WHERE project_id = ? ORDER BY created_at, operation_id`,
    )
    .all(projectId);
  return rows.map((row) => {
    const record = rowOf(row, "operations");
    return {
      operationId: requiredString(record, "operation_id"),
      runId: requiredString(record, "run_id"),
      operationKind: requiredString(record, "operation_kind"),
      dedupeKey: requiredString(record, "dedupe_key"),
      inputDigest: requiredString(record, "input_digest"),
      state: requiredString(record, "state"),
      reclaimable: requiredInt(record, "reclaimable") === 1,
      leaseGeneration: requiredInt(record, "lease_generation"),
      leaseOwner: optionalString(record, "lease_owner"),
      resultDigest: optionalString(record, "result_digest"),
      errorDigest: optionalString(record, "error_digest"),
      createdAt: requiredString(record, "created_at"),
      updatedAt: requiredString(record, "updated_at"),
    };
  });
}

export function scanOperations(runtime: StoreRuntime): OperationScanRow[] {
  const rows = runtime.db
    .prepare(
      `SELECT project_id, operation_id, run_id, operation_kind, dedupe_key, input_digest, state, reclaimable,
              lease_generation, result_digest, error_digest, created_at, updated_at, lease_until, lease_owner
       FROM operations ORDER BY project_id, operation_id`,
    )
    .all();
  return rows.map((row) => {
    const record = rowOf(row, "operations-scan");
    return {
      projectId: requiredString(record, "project_id"),
      operationId: requiredString(record, "operation_id"),
      runId: requiredString(record, "run_id"),
      operationKind: requiredString(record, "operation_kind"),
      dedupeKey: requiredString(record, "dedupe_key"),
      inputDigest: requiredString(record, "input_digest"),
      state: requiredString(record, "state"),
      reclaimable: requiredInt(record, "reclaimable") === 1,
      leaseGeneration: requiredInt(record, "lease_generation"),
      resultDigest: optionalString(record, "result_digest"),
      errorDigest: optionalString(record, "error_digest"),
      createdAt: requiredString(record, "created_at"),
      updatedAt: requiredString(record, "updated_at"),
      leaseUntil: optionalString(record, "lease_until"),
      leaseOwner: optionalString(record, "lease_owner"),
    };
  });
}

export function listClaimableOperations(
  runtime: StoreRuntime,
  projectIds: readonly string[],
  now: string,
): OperationScanRow[] {
  if (projectIds.length === 0) {
    return [];
  }
  const scanned = scanOperations(runtime);
  return scanned.filter((row) => {
    if (!projectIds.includes(row.projectId)) {
      return false;
    }
    if (row.state === "ready") {
      return true;
    }
    if (
      row.state === "leased" &&
      row.reclaimable &&
      row.leaseUntil !== undefined &&
      now > row.leaseUntil
    ) {
      return true;
    }
    if ((row.state === "failed" || row.state === "unknown") && row.reclaimable) {
      if (row.state === "failed" && row.operationKind === "SPAWN_AGENT") {
        return false;
      }
      return true;
    }
    return false;
  });
}

export function markOperationUnknown(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: MarkOperationUnknownInput,
): OperationRecord {
  const projectId = scopedProjectId(scope);
  return executeWrite(runtime, "markOperationUnknown", () => {
    const row = leaseRow(runtime, projectId, input.operationId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    if (!artifactExists(runtime, projectId, input.errorDigest)) {
      throw new StoreLookupError();
    }
    runtime.db
      .prepare(
        `UPDATE operations
         SET state = 'unknown',
             lease_owner = NULL,
             lease_until = NULL,
             lease_token_hash = NULL,
             result_digest = NULL,
             error_digest = ?,
             updated_at = ?
         WHERE project_id = ? AND operation_id = ?`,
      )
      .run(input.errorDigest, input.updatedAt, projectId, input.operationId);
    const done = readOperation(runtime, projectId, input.operationId);
    if (done === undefined) {
      throw new StoreLookupError();
    }
    return done;
  });
}

export function expireLeasesForOwner(
  runtime: StoreRuntime,
  input: { owner: string; leaseUntil: string },
): void {
  executeWrite(runtime, "expireLeasesForOwner", () => {
    runtime.db
      .prepare(
        `UPDATE operations SET lease_until = ?
         WHERE lease_owner = ? AND state = 'leased'`,
      )
      .run(input.leaseUntil, input.owner);
  });
}
