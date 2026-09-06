import type { PrincipalScope } from "@pi-hec/domain";
import { executeWrite } from "./crash.js";
import { decryptApiResponsePayload, encryptApiResponsePayload, responseAad } from "./crypto.js";
import { IdempotencyConflictError, ReconcileRequiredError, StoreLookupError } from "./errors.js";
import { optionalBlob, optionalInt, optionalString, requiredString, rowOf } from "./rows.js";
import type {
  CompleteIdempotencyInput,
  IdempotencyReplay,
  IdempotencyReservation,
  ReserveIdempotencyInput,
  StoreRuntime,
} from "./types.js";

type IdempotencyRow = {
  state: string;
  semanticRequestDigest: string;
  responseStatus: number | undefined;
  headers: Buffer | undefined;
  body: Buffer | undefined;
  keyId: string | undefined;
  nonce: string | undefined;
  scopeKey: string;
};

function readIdempotency(
  runtime: StoreRuntime,
  principalId: string,
  operationId: string,
): IdempotencyRow | undefined {
  const row = runtime.db
    .prepare(
      `SELECT scope_key, semantic_request_digest, state, response_status, response_headers_ciphertext,
              response_body_ciphertext, response_encryption_key_id, response_encryption_nonce
       FROM api_idempotency_requests
       WHERE principal_id = ? AND operation_id = ?`,
    )
    .get(principalId, operationId);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "api_idempotency_requests");
  return {
    state: requiredString(record, "state"),
    semanticRequestDigest: requiredString(record, "semantic_request_digest"),
    responseStatus: optionalInt(record, "response_status"),
    headers: optionalBlob(record, "response_headers_ciphertext"),
    body: optionalBlob(record, "response_body_ciphertext"),
    keyId: optionalString(record, "response_encryption_key_id"),
    nonce: optionalString(record, "response_encryption_nonce"),
    scopeKey: requiredString(record, "scope_key"),
  };
}

function decryptReplay(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  operationId: string,
  row: IdempotencyRow,
): IdempotencyReplay {
  if (row.state !== "completed" && row.state !== "failed") {
    throw new Error("idempotency row is not a replayable response");
  }
  if (
    row.responseStatus === undefined ||
    row.headers === undefined ||
    row.body === undefined ||
    row.nonce === undefined
  ) {
    throw new Error("incomplete encrypted idempotency response");
  }
  const aad = responseAad({
    principalId: scope.principalId,
    scopeKey: row.scopeKey,
    operationId,
    semanticRequestDigest: row.semanticRequestDigest,
  });
  const plain = decryptApiResponsePayload(
    runtime.dbResponseKey,
    aad,
    Buffer.from(row.nonce, "base64url"),
    row.headers,
    row.body,
  );
  return {
    state: row.state,
    responseStatus: row.responseStatus,
    headers: plain.headers,
    body: plain.body,
  };
}

export function reserveApiIdempotency(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  input: ReserveIdempotencyInput,
): IdempotencyReservation {
  return executeWrite(runtime, "reserveApiIdempotency", () => {
    const existing = readIdempotency(runtime, scope.principalId, input.operationId);
    if (existing !== undefined) {
      if (existing.semanticRequestDigest !== input.semanticRequestDigest) {
        throw new IdempotencyConflictError();
      }
      if (existing.state === "reconcile-required") {
        throw new ReconcileRequiredError();
      }
      if (existing.state === "reserved") {
        return { state: "reserved" as const };
      }
      if (existing.state === "completed" || existing.state === "failed") {
        return decryptReplay(runtime, scope, input.operationId, existing);
      }
      throw new Error(`unhandled union: ${JSON.stringify(existing.state)}`);
    }
    runtime.db
      .prepare(
        `INSERT INTO api_idempotency_requests(
          principal_id, operation_id, scope_key, method, target_uri, semantic_request_digest, state,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
      )
      .run(
        scope.principalId,
        input.operationId,
        input.scopeKey,
        input.method,
        input.targetUri,
        input.semanticRequestDigest,
        input.createdAt,
        input.createdAt,
        input.expiresAt,
      );
    return { state: "reserved" as const };
  });
}

function finishIdempotency(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  input: CompleteIdempotencyInput,
  state: "completed" | "failed",
): void {
  executeWrite(
    runtime,
    state === "completed" ? "completeApiIdempotency" : "failApiIdempotency",
    () => {
      const existing = readIdempotency(runtime, scope.principalId, input.operationId);
      if (existing === undefined) {
        throw new StoreLookupError();
      }
      if (existing.semanticRequestDigest !== input.semanticRequestDigest) {
        throw new IdempotencyConflictError();
      }
      if (existing.state === "reconcile-required") {
        throw new ReconcileRequiredError();
      }
      if (existing.state !== "reserved") {
        throw new IdempotencyConflictError();
      }
      const aad = responseAad({
        principalId: scope.principalId,
        scopeKey: input.scopeKey,
        operationId: input.operationId,
        semanticRequestDigest: input.semanticRequestDigest,
      });
      const encrypted = encryptApiResponsePayload(
        runtime.dbResponseKey,
        runtime.responseKeyId,
        aad,
        input.headers,
        input.body,
      );
      runtime.db
        .prepare(
          `UPDATE api_idempotency_requests
         SET state = ?,
             response_status = ?,
             response_headers_ciphertext = ?,
             response_body_ciphertext = ?,
             response_encryption_key_id = ?,
             response_encryption_nonce = ?,
             updated_at = ?
         WHERE principal_id = ? AND operation_id = ? AND state = 'reserved'`,
        )
        .run(
          state,
          input.responseStatus,
          encrypted.headersCiphertext,
          encrypted.bodyCiphertext,
          encrypted.keyId,
          encrypted.nonce.toString("base64url"),
          input.updatedAt,
          scope.principalId,
          input.operationId,
        );
    },
  );
}

export function completeApiIdempotency(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  input: CompleteIdempotencyInput,
): void {
  finishIdempotency(runtime, scope, input, "completed");
}

export function failApiIdempotency(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  input: CompleteIdempotencyInput,
): void {
  finishIdempotency(runtime, scope, input, "failed");
}

export function markApiIdempotencyReconcileRequired(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  input: { operationId: string; updatedAt: string },
): void {
  executeWrite(runtime, "markApiIdempotencyReconcileRequired", () => {
    const existing = readIdempotency(runtime, scope.principalId, input.operationId);
    if (existing === undefined) {
      throw new StoreLookupError();
    }
    runtime.db
      .prepare(
        `UPDATE api_idempotency_requests
         SET state = 'reconcile-required',
             response_status = NULL,
             response_headers_ciphertext = NULL,
             response_body_ciphertext = NULL,
             response_encryption_key_id = NULL,
             response_encryption_nonce = NULL,
             updated_at = ?
         WHERE principal_id = ? AND operation_id = ?`,
      )
      .run(input.updatedAt, scope.principalId, input.operationId);
  });
}

export function getApiIdempotency(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  operationId: string,
): IdempotencyReservation | { state: "reserved" | "reconcile-required" } {
  const existing = readIdempotency(runtime, scope.principalId, operationId);
  if (existing === undefined) {
    throw new StoreLookupError();
  }
  if (existing.state === "reconcile-required") {
    throw new ReconcileRequiredError();
  }
  if (existing.state === "reserved") {
    return { state: "reserved" };
  }
  if (existing.state === "completed" || existing.state === "failed") {
    return decryptReplay(runtime, scope, operationId, existing);
  }
  throw new Error(`unhandled union: ${JSON.stringify(existing.state)}`);
}
