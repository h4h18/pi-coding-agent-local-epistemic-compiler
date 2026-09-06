import { randomBytes, X509Certificate, type KeyObject } from "node:crypto";
import { TLSSocket, type DetailedPeerCertificate } from "node:tls";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  canonicalizeRfc8785,
  HTTP_OPERATIONS,
  isObjectDigest,
  isRunId,
  objectDigestFromBytes,
  sha256Utf8,
  type ApiError,
  type HttpOperationSpec,
  type MaybePromise,
  type ObjectDigest,
  type PrincipalScope,
  type RunId,
} from "@pi-hec/contracts";
import {
  IdempotencyConflictError,
  LeaseError,
  StateVersionConflictError,
  StoreLookupError,
  UntrustedProjectError,
  type ArtifactInput,
  type IdempotencyReplay,
  type StateStore,
} from "@pi-hec/state-store";
import type { FilesystemCas, PutObjectResult } from "@pi-hec/cas";
import {
  MUTATION_PROFILE_TAG,
  constructPrincipalScope,
  contentDigestSha256,
  verifyMutation,
  type ApprovalNonceRegistry,
  type CertificatePrincipalRecord,
  type IdentityStorePort,
  type NonceCache,
  type ProjectGrantRecord,
} from "@pi-hec/security";
import type { Scheduler } from "./scheduler.js";

export type AppContext = {
  store: StateStore;
  cas: FilesystemCas;
  identity: IdentityStorePort;
  nonceCache: NonceCache;
  clock: () => string;
  hostSignerDigest: ObjectDigest;
  hostPolicyDigest: ObjectDigest;
  hostCapabilityDigest: ObjectDigest;
  hostGrantPolicyDigest: ObjectDigest;
  blobLimit: number;
  jsonLimit: number;
  leaseWaitMs: number;
  scheduler: Scheduler;
  signingKeys: Map<string, KeyObject>;
  brokerPrivateKey: KeyObject;
  brokerKeyId: string;
  brokerCertificateObjectDigest: ObjectDigest;
  approvalNonces: ApprovalNonceRegistry;
  hostAdminRecord: CertificatePrincipalRecord;
  hostCaCertPem: string;
  hostCaPrivateKey: KeyObject;
};

export type RegistryRoute = {
  method: string;
  path: string;
  operationId: string;
};

export function findOperation(operationId: string): HttpOperationSpec {
  const found = HTTP_OPERATIONS.find((operation) => operation.operationId === operationId);
  if (found === undefined) {
    throw new Error(`unknown operation ${operationId}`);
  }
  return found;
}

export function toFastifyUrl(path: string): string {
  const names: string[] = [];
  const slotted = path.replaceAll(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
    names.push(name);
    return "\0";
  });
  const escaped = slotted.replaceAll(":", "::");
  let index = 0;
  return escaped.replaceAll("\0", (slot: string, offset: number, whole: string) => {
    const name = names[index];
    index += 1;
    if (name === undefined) {
      throw new Error("path param slot missing");
    }
    const after = whole.slice(offset + slot.length);
    if (after.startsWith("::")) {
      return `:${name}(^[^:]+)`;
    }
    return `:${name}`;
  });
}

export function quotedEtag(value: string | number): string {
  return `"${String(value)}"`;
}

export function parseIfMatch(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^"([^"]+)"$/.exec(header.trim());
  return match?.[1];
}

export function parseStateVersion(header: string | undefined): number | undefined {
  const raw = parseIfMatch(header);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(raw)) {
    return undefined;
  }
  return Number.parseInt(raw, 10);
}

export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  const six = bytes[6] ?? 0;
  const eight = bytes[8] ?? 0;
  bytes[6] = (six & 0x0f) | 0x70;
  bytes[8] = (eight & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newOperationId(): `op_${string}` {
  return `op_${uuidV7()}`;
}

export function newApprovalId(): `approval_${string}` {
  return `approval_${uuidV7()}`;
}

export function apiErrorBody(
  code: ApiError["code"],
  message: string,
  extras: { operationId?: string; runId?: string } = {},
): ApiError {
  const retryClass: ApiError["retryClass"] =
    code === "TEMPORARILY_UNAVAILABLE"
      ? "safe"
      : code === "INTERNAL"
        ? "ambiguous"
        : "never";
  const base = {
    schemaVersion: 1 as const,
    code,
    message,
    retryClass,
  };
  if (extras.operationId !== undefined && extras.runId !== undefined) {
    return {
      ...base,
      operationId: extras.operationId,
      runId: extras.runId,
    };
  }
  if (extras.operationId !== undefined) {
    return { ...base, operationId: extras.operationId };
  }
  if (extras.runId !== undefined) {
    return { ...base, runId: extras.runId };
  }
  return base;
}

export async function sendError(
  reply: FastifyReply,
  status: number,
  code: ApiError["code"],
  message: string,
  extras: { operationId?: string; headers?: Record<string, string> } = {},
): Promise<void> {
  if (status === 403) {
    await sendError(reply, 404, "NOT_FOUND", "not found", extras);
    return;
  }
  if (extras.headers !== undefined) {
    for (const [key, value] of Object.entries(extras.headers)) {
      void reply.header(key, value);
    }
  }
  await reply.code(status).type("application/json").send(apiErrorBody(code, message, extras));
}

export function headerRecord(reply: FastifyReply): Record<string, string> {
  const raw = reply.getHeaders();
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (typeof value === "number") {
      headers[key.toLowerCase()] = String(value);
    } else if (Array.isArray(value) && value[0] !== undefined) {
      headers[key.toLowerCase()] = value.join(", ");
    }
  }
  return headers;
}

export function encodeHeaderBag(headers: Record<string, string>): Uint8Array {
  return Buffer.from(canonicalizeRfc8785(headers), "utf8");
}

export function decodeHeaderBag(bytes: Buffer): Record<string, string> {
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid stored headers");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return headers;
}

export async function replayResponse(reply: FastifyReply, replay: IdempotencyReplay): Promise<void> {
  const headers = decodeHeaderBag(replay.headers);
  for (const [key, value] of Object.entries(headers)) {
    void reply.header(key, value);
  }
  if (replay.responseStatus === 304 || replay.responseStatus === 204) {
    await reply.code(replay.responseStatus).send();
    return;
  }
  await reply.code(replay.responseStatus).send(replay.body);
}

export function semanticDigest(input: {
  principalId: string;
  audience: string;
  scopeKey: string;
  operationId: string;
  method: string;
  targetUri: string;
  contentType: string;
  bodyDigest: string;
  ifMatch?: string;
}): string {
  return sha256Utf8(
    canonicalizeRfc8785({
      principalId: input.principalId,
      audience: input.audience,
      scopeKey: input.scopeKey,
      operationId: input.operationId,
      method: input.method.toUpperCase(),
      targetUri: input.targetUri,
      contentType: input.contentType,
      bodyDigest: input.bodyDigest,
      ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
    }),
  );
}

export function requireMatchingStateVersion(header: string | undefined, actual: number): void {
  if (header === undefined) {
    throw new HttpSignal(428, "PRECONDITION_REQUIRED", "if-match required");
  }
  const version = parseStateVersion(header);
  if (version === undefined) {
    throw new HttpSignal(428, "PRECONDITION_REQUIRED", "if-match required");
  }
  if (version !== actual) {
    throw new HttpSignal(412, "STATE_VERSION_MISMATCH", "state version mismatch");
  }
}

export function bootstrapEnrollmentScope(ctx: AppContext, challengeId: string): PrincipalScope {
  return constructPrincipalScope({
    record: {
      ...ctx.hostAdminRecord,
      principalId: `bootstrap:${challengeId}`,
      identityKind: "runner",
      audiences: ["bootstrap"],
    },
    grants: [],
    authenticatedAt: ctx.clock(),
  });
}

export function hostAdminScope(ctx: AppContext): PrincipalScope {
  return constructPrincipalScope({
    record: ctx.hostAdminRecord,
    grants: ctx.identity.listAllProjects().map((project) => ({
      projectId: project.projectId,
      roles: ["admin"],
      grantObjectDigest: project.grantObjectDigest,
      revokedAt: undefined,
    })),
    authenticatedAt: ctx.clock(),
  });
}

export function requireScope(request: FastifyRequest): PrincipalScope {
  const scope = request.principalScope;
  if (scope === undefined) {
    throw new UnauthenticatedError();
  }
  return scope;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("unauthenticated");
    this.name = "UnauthenticatedError";
  }
}

export class HttpSignal extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiError["code"],
    message: string,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = "HttpSignal";
  }
}

export function asRunId(value: string): RunId {
  if (!isRunId(value)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "invalid run id");
  }
  return value;
}

export function asObjectDigest(value: string): ObjectDigest {
  if (!isObjectDigest(value)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "invalid object digest");
  }
  return value;
}

export function optionalOperation(operationId: string | undefined): { operationId: string } | Record<never, never> {
  return operationId === undefined ? {} : { operationId };
}

export function mediaTypeOf(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const semi = header.indexOf(";");
  const raw = semi < 0 ? header : header.slice(0, semi);
  return raw.trim().toLowerCase();
}

export function parseJsonBody(request: FastifyRequest): unknown {
  if (request.rawBody !== undefined) {
    try {
      return JSON.parse(request.rawBody.toString("utf8"));
    } catch {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
  }
  return request.body;
}

export function enforceMutationGuards(
  spec: HttpOperationSpec,
  request: FastifyRequest,
  jsonLimit: number,
): void {
  if (spec.class === "read") {
    return;
  }
  const media = mediaTypeOf(request.headers["content-type"]);
  if (spec.class === "content") {
    if (media !== "application/octet-stream") {
      throw new HttpSignal(415, "MEDIA_TYPE_UNSUPPORTED", "media type unsupported");
    }
    return;
  }
  if (media !== "application/json") {
    throw new HttpSignal(415, "MEDIA_TYPE_UNSUPPORTED", "media type unsupported");
  }
  const raw = request.rawBody;
  if (raw !== undefined && raw.byteLength > jsonLimit) {
    throw new HttpSignal(413, "CONTENT_TOO_LARGE", "body too large");
  }
}

export function requireJsonMutation(
  request: FastifyRequest,
  spec: HttpOperationSpec,
  jsonLimit: number,
): { operationId: string; raw: Buffer; digest: string } {
  const media = mediaTypeOf(request.headers["content-type"]);
  if (media !== "application/json") {
    throw new HttpSignal(415, "MEDIA_TYPE_UNSUPPORTED", "application/json required");
  }
  const raw = request.rawBody;
  if (raw === undefined) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "missing body");
  }
  if (raw.byteLength > jsonLimit) {
    throw new HttpSignal(413, "CONTENT_TOO_LARGE", "body too large");
  }
  const lengthHeader = request.headers["content-length"];
  if (lengthHeader !== undefined && Number.parseInt(lengthHeader, 10) !== raw.byteLength) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "content-length mismatch");
  }
  const digestHeader = request.headers["content-digest"];
  const computed = contentDigestSha256(raw);
  if (typeof digestHeader !== "string" || digestHeader !== computed) {
    throw new HttpSignal(422, "CONTENT_DIGEST_MISMATCH", "content-digest mismatch");
  }
  const operationId = request.headers["operation-id"];
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "operation-id required");
  }
  void spec;
  return { operationId, raw, digest: computed };
}

export type IdempotentResponse = { status: number; headers: Record<string, string>; body: Buffer };

function projectScopeKey(params: unknown): string {
  if (params === null || typeof params !== "object" || !("projectId" in params)) {
    return "admin";
  }
  const projectId: unknown = params.projectId;
  return typeof projectId === "string" ? projectId : "admin";
}

export async function withIdempotency(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  spec: HttpOperationSpec | undefined,
  work: () => MaybePromise<IdempotentResponse>,
  scopeOverride?: PrincipalScope,
): Promise<void> {
  if (spec === undefined) {
    throw new HttpSignal(404, "NOT_FOUND", "not found");
  }
  const scope = scopeOverride ?? requireScope(request);
  const json = requireJsonMutation(request, spec, ctx.jsonLimit);
  const targetUri = `${request.protocol}://${request.headers.host ?? "localhost"}${request.url}`;
  const digestInput = {
    principalId: scope.principalId,
    audience: scope.audiences[0] ?? scope.identityKind,
    scopeKey: projectScopeKey(request.params),
    operationId: json.operationId,
    method: spec.method,
    targetUri,
    contentType: "application/json",
    bodyDigest: json.digest,
    ...(typeof request.headers["if-match"] === "string" ? { ifMatch: request.headers["if-match"] } : {}),
  };
  const digest = semanticDigest(digestInput);
  const now = ctx.clock();
  try {
    const reserved = ctx.store.reserveApiIdempotency(scope, {
      operationId: json.operationId,
      scopeKey: digest,
      method: spec.method,
      targetUri,
      semanticRequestDigest: digest,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 24 * 3600_000).toISOString(),
    });
    if (reserved.state === "completed" || reserved.state === "failed") {
      void reply.header("operation-id", json.operationId);
      await replayResponse(reply, reserved);
      return;
    }
    const result = await work();
    ctx.store.completeApiIdempotency(scope, {
      operationId: json.operationId,
      scopeKey: digest,
      semanticRequestDigest: digest,
      responseStatus: result.status,
      headers: encodeHeaderBag({ ...result.headers, "operation-id": json.operationId }),
      body: result.body,
      updatedAt: ctx.clock(),
    });
    for (const [key, value] of Object.entries(result.headers)) {
      void reply.header(key, value);
    }
    void reply.header("operation-id", json.operationId);
    if (result.status === 204 || result.status === 304) {
      await reply.code(result.status).send();
      return;
    }
    await reply.code(result.status).type("application/json").send(result.body);
  } catch (error) {
    await mapStoreError(reply, error, json.operationId);
  }
}

export async function mapStoreError(reply: FastifyReply, error: unknown, operationId?: string): Promise<void> {
  const extras: { operationId?: string; headers?: Record<string, string> } = {
    ...optionalOperation(error instanceof HttpSignal ? (error.operationId ?? operationId) : operationId),
    ...(operationId === undefined ? {} : { headers: { "operation-id": operationId } }),
  };
  if (error instanceof HttpSignal) {
    await sendError(reply, error.status, error.code, error.message, extras);
    return;
  }
  if (error instanceof UnauthenticatedError) {
    await sendError(reply, 401, "AUTHENTICATION_FAILED", "authentication failed");
    return;
  }
  if (error instanceof StoreLookupError || error instanceof UntrustedProjectError) {
    await sendError(reply, 404, "NOT_FOUND", "not found", extras);
    return;
  }
  if (error instanceof IdempotencyConflictError) {
    await sendError(reply, 409, "OPERATION_ID_REUSED", "operation id reused", extras);
    return;
  }
  if (error instanceof StateVersionConflictError) {
    await sendError(reply, 412, "STATE_VERSION_MISMATCH", "state version mismatch", extras);
    return;
  }
  if (error instanceof LeaseError) {
    const expired = error.message.includes("expired");
    await sendError(
      reply,
      expired ? 410 : 409,
      expired ? "LEASE_EXPIRED" : "LEASE_INVALID",
      expired ? "lease expired" : "lease invalid",
      extras,
    );
    return;
  }
  await sendError(reply, 500, "INTERNAL", "internal error", extras);
}

export async function putBytes(
  ctx: AppContext,
  projectId: string,
  bytes: Uint8Array,
  mediaType: string,
  classification: "public" | "internal" | "confidential" | "restricted",
  schemaName?: string,
): Promise<PutObjectResult> {
  return ctx.cas.putObject({
    projectId,
    bytes,
    mediaType,
    classification,
    ...(schemaName === undefined ? {} : { schemaName }),
  });
}

export function artifactInputFromCas(
  ctx: AppContext,
  result: PutObjectResult,
  now: string,
  schemaName: string | null,
): ArtifactInput {
  const record = result.storageRecord;
  return {
    digest: result.objectDigest,
    schemaName,
    mediaType: record.mediaType,
    byteSize: record.plaintextByteSize,
    classification: record.classification,
    encryptionAlgorithm: record.encryptionAlgorithm,
    encryptionKeyId: record.encryptionKeyId,
    encryptionNonce: record.encryptionNonceBase64,
    storageRecordDigest: result.storageRecordDigest,
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: now,
    storageRecordSignerCertificateDigest: ctx.hostSignerDigest,
    storageRecordSignature: Buffer.from(MUTATION_PROFILE_TAG).toString("base64"),
    createdAt: now,
  };
}

export function digestLabel(label: string): ObjectDigest {
  return sha256Utf8(label) as ObjectDigest;
}

export function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export async function persistCasArtifact(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  bytes: Uint8Array,
  mediaType: string,
  classification: "public" | "internal" | "confidential" | "restricted",
  schemaName: string | null,
): Promise<ObjectDigest> {
  const result = await putBytes(
    ctx,
    projectId,
    bytes,
    mediaType,
    classification,
    schemaName ?? undefined,
  );
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  if (!ctx.store.hasArtifact(projectScope, result.objectDigest)) {
    ctx.store.putArtifact(projectScope, artifactInputFromCas(ctx, result, ctx.clock(), schemaName));
  }
  return result.objectDigest;
}

export { objectDigestFromBytes };

export function verifyMutationOrThrow(
  ctx: AppContext,
  request: FastifyRequest,
  spec: HttpOperationSpec,
): void {
  if (spec.class === "read") {
    return;
  }
  const scope = request.principalScope;
  if (scope === undefined) {
    if (spec.audiences.includes("bootstrap")) {
      return;
    }
    throw new UnauthenticatedError();
  }
  const key = ctx.signingKeys.get(scope.principalId) ?? peerPublicKey(request);
  if (key === undefined) {
    throw new UnauthenticatedError();
  }
  const raw = request.rawBody ?? Buffer.alloc(0);
  const host = request.headers.host ?? "localhost";
  const targetUri = `https://${host}${request.url}`;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers[name.toLowerCase()] = value;
    }
  }
  const verified = verifyMutation({
    message: {
      method: spec.method,
      authority: host,
      targetUri,
      headers,
      body: raw,
    },
    publicKey: key,
    nowSeconds: Math.floor(Date.parse(ctx.clock()) / 1000),
    expectedKeyId: scope.principalId,
  });
  if (!verified.ok) {
    throw new UnauthenticatedError();
  }
  const nonce = verified.params.nonce;
  const operationId = typeof request.headers["operation-id"] === "string" ? request.headers["operation-id"] : "";
  const reserved = ctx.nonceCache.reserve({
    principalId: scope.principalId,
    keyId: verified.params.keyid,
    nonce,
    operationId,
    expiresAtMs: verified.params.expires * 1000,
  });
  if (reserved === "conflict") {
    throw new UnauthenticatedError();
  }
}

export function authorizedPeerCertificateDer(socket: unknown): Buffer | undefined {
  if (!(socket instanceof TLSSocket) || !socket.authorized) {
    return undefined;
  }
  const peer: Partial<DetailedPeerCertificate> = socket.getPeerCertificate(true);
  return peer.raw;
}

function peerPublicKey(request: FastifyRequest): KeyObject | undefined {
  const der = authorizedPeerCertificateDer(request.raw.socket);
  if (der === undefined) {
    return undefined;
  }
  return new X509Certificate(der).publicKey;
}

export class ProjectListingIdentityStore implements IdentityStorePort {
  constructor(
    private readonly inner: IdentityStorePort,
    private readonly listFromStore: () => readonly { projectId: string; grantObjectDigest: ObjectDigest }[],
  ) {}

  lookupBySerialAndSpki(serial: string, spkiSha256: string): CertificatePrincipalRecord | undefined {
    return this.inner.lookupBySerialAndSpki(serial, spkiSha256);
  }

  listGrants(principalId: string): readonly ProjectGrantRecord[] {
    return this.inner.listGrants(principalId);
  }

  listAllProjects(): readonly { projectId: string; grantObjectDigest: ObjectDigest }[] {
    const listed = this.listFromStore();
    if (listed.length > 0) {
      return listed;
    }
    return this.inner.listAllProjects();
  }
}

export {
  buildContextDelta,
  handleContextFallback,
  handleRepairAfterVerdict,
  isUnboundedContextRequest,
  newCloudCallId,
} from "../services/context-jobs.js";
export type {
  ContextFallbackInput,
  ContextFallbackResult,
  ContextFollowUpDispatch,
  RepairCompileDispatch,
  RepairOrchestrationInput,
  RepairOrchestrationResult,
  RetrievedContextEvidence,
} from "../services/context-jobs.js";

