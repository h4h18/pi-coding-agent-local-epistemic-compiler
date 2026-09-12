import { randomBytes, randomUUID } from "node:crypto";
import { Compile } from "typebox/compile";
import {
  CreateRunnerEnrollmentChallengeRequestSchema,
  EnrollRunnerRequestSchema,
  RevokeRunnerRequestSchema,
  RotateRunnerCertificateRequestSchema,
  RunnerLeaseRequestSchema,
  canonicalizeRfc8785,
  objectDigestFromBytes,
} from "@pi-hec/contracts";
import { UntrustedProjectError, StoreLookupError } from "@pi-hec/state-store";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  HttpSignal,
  bootstrapEnrollmentScope,
  hostAdminScope,
  jsonBuffer,
  mapStoreError,
  requireScope,
  withIdempotency,
  type AppContext,
} from "../orchestration/handlers.js";
import {
  issueLeafCertificate,
  parseAndVerifyCsr,
  parseSpkiPemOrB64,
  verifyProofOfPossession,
} from "../pki.js";

const CHALLENGE = Compile(CreateRunnerEnrollmentChallengeRequestSchema);
const ENROLL = Compile(EnrollRunnerRequestSchema);
const REVOKE = Compile(RevokeRunnerRequestSchema);
const ROTATE = Compile(RotateRunnerCertificateRequestSchema);
const LEASE = Compile(RunnerLeaseRequestSchema);

const RUNNER_OPERATION_KINDS = new Set([
  "CAPTURE_SNAPSHOT",
  "UPLOAD_SNAPSHOT",
  "APPLY_USER_INPUT",
  "REQUEST_REPAIR",
  "REQUEST_CANCELLATION",
  "PROMOTE_WORKSPACE",
]);

const WORKER_OPERATION_KINDS = new Set([
  "RESOLVE_INSTRUCTIONS",
  "INDEX_SNAPSHOT",
  "PLAN_BASELINE",
  "RUN_BASELINE_CHECK",
  "RUN_PREFLIGHT",
  "COMPILE_CONTEXT",
  "MATERIALIZE_CANDIDATE",
  "PLAN_VERIFICATION",
  "RUN_VERIFICATION_CHECK",
  "PREPARE_REPAIR",
]);

function proofMessage(kind: "enroll" | "rotate", runnerId: string, challengeId?: string): string {
  if (kind === "enroll") {
    return `enroll:${challengeId ?? ""}:${runnerId}`;
  }
  return `rotate:${runnerId}`;
}

function verifyCsrAndProof(input: {
  publicKeySpki: string;
  certificateSigningRequestPem: string;
  proofOfPossession: string;
  message: string;
}): ReturnType<typeof parseAndVerifyCsr> {
  let parsed;
  try {
    parsed = parseAndVerifyCsr(input.certificateSigningRequestPem);
  } catch {
    throw new HttpSignal(422, "DOMAIN_INVARIANT_FAILED", "csr invalid");
  }
  const declared = parseSpkiPemOrB64(input.publicKeySpki);
  if (!parsed.spkiDer.equals(declared)) {
    throw new HttpSignal(422, "DOMAIN_INVARIANT_FAILED", "spki mismatch");
  }
  if (
    !verifyProofOfPossession({
      publicKey: parsed.publicKey,
      message: input.message,
      proofOfPossession: input.proofOfPossession,
    })
  ) {
    throw new HttpSignal(422, "DOMAIN_INVARIANT_FAILED", "proof of possession failed");
  }
  return parsed;
}

function issueRunnerLeaf(
  ctx: AppContext,
  runnerId: string,
  spkiDer: Buffer,
): ReturnType<typeof issueLeafCertificate> {
  const now = Date.now();
  return issueLeafCertificate({
    caCertPem: ctx.hostCaCertPem,
    caPrivateKey: ctx.hostCaPrivateKey,
    spkiDer,
    subject: runnerId,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 30 * 24 * 3600_000),
  });
}

function persistIssuedCertificate(
  ctx: AppContext,
  runnerId: string,
  leaf: ReturnType<typeof issueLeafCertificate>,
  now: string,
): void {
  const admin = hostAdminScope(ctx);
  ctx.store.insertRunnerCertificate(admin, {
    certificateSerial: leaf.serial,
    runnerId,
    spkiSha256: leaf.spkiSha256,
    notBefore: leaf.notBefore,
    notAfter: leaf.notAfter,
    issuedAt: now,
  });
}

function grantPermittedProjects(
  ctx: AppContext,
  runnerId: string,
  projectIds: readonly string[],
  now: string,
): void {
  const admin = hostAdminScope(ctx);
  for (const projectId of projectIds) {
    try {
      const projectScope = ctx.store.toProjectScope(admin, projectId);
      ctx.store.grantRunnerProject(projectScope, {
        runnerId,
        capabilityPolicyDigest: ctx.hostGrantPolicyDigest,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof UntrustedProjectError || error instanceof StoreLookupError) {
        continue;
      }
      const message = error instanceof Error ? error.message : "";
      if (message.includes("UNIQUE")) {
        continue;
      }
      throw error;
    }
  }
}

function decodePermittedProjectIds(ctx: AppContext, digest: string): string[] {
  const artifact = ctx.store.getHostAuthorityArtifact(digest);
  if (artifact === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(artifact.signature, "base64").toString("utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("permittedProjectIds" in parsed)
    ) {
      return [];
    }
    const ids = Reflect.get(parsed, "permittedProjectIds");
    if (!Array.isArray(ids)) {
      return [];
    }
    return ids.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export async function createRunnerEnrollmentChallenge(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    if (!CHALLENGE.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const scope = requireScope(request);
    const now = ctx.clock();
    const challengeId = `enroll-${randomUUID()}`;
    const secret = randomBytes(32).toString("base64url");
    const permittedPayload = canonicalizeRfc8785({
      permittedProjectIds: [...request.body.permittedProjectIds],
    });
    const permittedBytes = Buffer.from(permittedPayload, "utf8");
    const permitted = objectDigestFromBytes(permittedBytes);
    ctx.store.putHostAuthorityArtifact({
      objectDigest: permitted,
      schemaName: "PermittedProjects",
      mediaType: "application/json",
      byteSize: permittedBytes.byteLength,
      encryptionKeyId: `host-key:${challengeId}`,
      encryptionNonce: challengeId.padEnd(24, "0").slice(0, 24),
      signatureKeyId: "host-sign",
      signature: permittedBytes.toString("base64"),
      createdAt: now,
    });
    await ctx.store.createEnrollmentChallenge(scope, {
      challengeId,
      secret: Buffer.from(secret, "utf8"),
      permittedProjectsDigest: permitted,
      expiresAt: new Date(Date.parse(now) + request.body.expiresInSeconds * 1000).toISOString(),
      createdByPrincipalId: scope.principalId,
      createdAt: now,
    });
    const body = {
      schemaVersion: 1 as const,
      challengeId,
      oneTimeSecret: secret,
      permittedProjectIds: [...request.body.permittedProjectIds],
      expiresAt: new Date(Date.parse(now) + request.body.expiresInSeconds * 1000).toISOString(),
    };
    return {
      status: 201,
      headers: {
        location: `/v1/admin/runner-enrollment-challenges/${challengeId}`,
        "cache-control": "no-store",
      },
      body: jsonBuffer(body),
    };
  });
}

export async function revokeRunner(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, () => {
    if (!REVOKE.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const scope = requireScope(request);
    const runnerId = (request.params as { runnerId: string }).runnerId;
    ctx.store.revokeRunner(scope, {
      runnerId,
      reason: request.body.reason,
      effectiveAt: request.body.effectiveAt,
    });
    return { status: 204, headers: {}, body: Buffer.alloc(0) };
  });
}

export async function enrollRunner(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!ENROLL.Check(request.body)) {
    await mapStoreError(reply, new HttpSignal(400, "SCHEMA_INVALID", "schema invalid"));
    return;
  }
  const body = request.body;
  const pathRunnerId = (request.params as { runnerId: string }).runnerId;
  if (pathRunnerId !== body.runnerId) {
    await mapStoreError(reply, new HttpSignal(404, "NOT_FOUND", "not found"));
    return;
  }
  const ok = await ctx.store.verifyEnrollmentSecret(
    body.challengeId,
    Buffer.from(body.oneTimeSecret, "utf8"),
  );
  if (!ok) {
    await mapStoreError(reply, new HttpSignal(404, "NOT_FOUND", "not found"));
    return;
  }
  const challenge = ctx.store.getEnrollmentChallenge(body.challengeId);
  if (challenge === undefined || ctx.clock() > challenge.expiresAt) {
    await mapStoreError(reply, new HttpSignal(404, "NOT_FOUND", "not found"));
    return;
  }
  await withIdempotency(
    ctx,
    request,
    reply,
    request.operationSpec,
    () => {
      const current = ctx.store.getEnrollmentChallenge(body.challengeId);
      if (current === undefined || ctx.clock() > current.expiresAt) {
        throw new HttpSignal(404, "NOT_FOUND", "not found");
      }
      const parsed = verifyCsrAndProof({
        publicKeySpki: body.publicKeySpki,
        certificateSigningRequestPem: body.certificateSigningRequestPem,
        proofOfPossession: body.proofOfPossession,
        message: proofMessage("enroll", body.runnerId, body.challengeId),
      });
      if (current.consumedAt !== undefined) {
        throw new HttpSignal(404, "NOT_FOUND", "not found");
      }
      const now = ctx.clock();
      const admin = hostAdminScope(ctx);
      ctx.store.consumeEnrollmentChallenge({ challengeId: body.challengeId, consumedAt: now });
      ctx.store.createRunner(admin, {
        runnerId: body.runnerId,
        principalId: `runner-${body.runnerId}`,
        platform: body.platform,
        capabilityDigest: ctx.hostCapabilityDigest,
        lastSeenAt: now,
      });
      const grantedProjectIds = decodePermittedProjectIds(ctx, current.permittedProjectsDigest);
      grantPermittedProjects(ctx, body.runnerId, grantedProjectIds, now);
      const leaf = issueRunnerLeaf(ctx, body.runnerId, parsed.spkiDer);
      persistIssuedCertificate(ctx, body.runnerId, leaf, now);
      const response = {
        schemaVersion: 1 as const,
        runnerId: body.runnerId,
        certificatePem: leaf.certificatePem,
        certificateChainPem: [...leaf.certificateChainPem],
        expiresAt: leaf.expiresAt,
        grantedProjectIds,
      };
      return {
        status: 201,
        headers: {
          location: `/v1/runners/${body.runnerId}`,
          "cache-control": "no-store",
        },
        body: jsonBuffer(response),
      };
    },
    bootstrapEnrollmentScope(ctx, body.challengeId),
  );
}

export async function rotateRunnerCertificate(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, () => {
    if (!ROTATE.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const runnerId = (request.params as { runnerId: string }).runnerId;
    const scope = requireScope(request);
    const bound = ctx.store.lookupRunnerCertificateBySerial(scope.certificateSerial);
    if (bound === undefined || bound.runnerId !== runnerId) {
      throw new HttpSignal(404, "NOT_FOUND", "not found");
    }
    const parsed = verifyCsrAndProof({
      publicKeySpki: request.body.publicKeySpki,
      certificateSigningRequestPem: request.body.certificateSigningRequestPem,
      proofOfPossession: request.body.proofOfPossession,
      message: proofMessage("rotate", runnerId),
    });
    const now = ctx.clock();
    const leaf = issueRunnerLeaf(ctx, runnerId, parsed.spkiDer);
    persistIssuedCertificate(ctx, runnerId, leaf, now);
    const grants = ctx.store.listRunnerProjectGrants(runnerId);
    return {
      status: 201,
      headers: { location: `/v1/runners/${runnerId}`, "cache-control": "no-store" },
      body: jsonBuffer({
        schemaVersion: 1,
        runnerId,
        certificatePem: leaf.certificatePem,
        certificateChainPem: [...leaf.certificateChainPem],
        expiresAt: leaf.expiresAt,
        grantedProjectIds: grants.map((grant) => grant.projectId),
      }),
    };
  });
}

export async function leaseRunnerJob(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    if (!LEASE.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const scope = requireScope(request);
    const kind = scope.identityKind;
    if (kind === "runner") {
      const runner = ctx.store.getRunnerByPrincipalId(scope.principalId);
      if (runner === undefined || runner.revokedAt !== undefined) {
        throw new HttpSignal(401, "AUTHENTICATION_FAILED", "authentication failed");
      }
    } else if (kind !== "worker") {
      throw new HttpSignal(401, "AUTHENTICATION_FAILED", "authentication failed");
    }
    const allowedKinds =
      kind === "worker"
        ? WORKER_OPERATION_KINDS
        : RUNNER_OPERATION_KINDS;
    const projectIds = scope.projectGrants.map((grant) => grant.projectId);
    let now = ctx.clock();
    let claimable = ctx.store
      .listClaimableOperations(projectIds, now)
      .filter((operation) => allowedKinds.has(operation.operationKind));
    if (claimable[0] === undefined) {
      await ctx.scheduler.waitForWork(ctx.leaseWaitMs);
      now = ctx.clock();
      claimable = ctx.store
        .listClaimableOperations(projectIds, now)
        .filter((operation) => allowedKinds.has(operation.operationKind));
    }
    const first = claimable[0];
    void reply.header("cache-control", "no-store");
    if (first === undefined) {
      await reply
        .code(200)
        .send({ schemaVersion: 1, outcome: "NO_JOB", retryAfterMs: ctx.leaseWaitMs });
      return;
    }
    const projectScope = ctx.store.toProjectScope(scope, first.projectId);
    const leaseUntil = new Date(Date.parse(now) + 30_000).toISOString();
    const leased = ctx.store.leaseOperation(projectScope, {
      operationId: first.operationId,
      owner: scope.principalId,
      leaseUntil,
      now,
    });
    await reply.code(200).send({
      schemaVersion: 1,
      outcome: "LEASED",
      projectId: first.projectId,
      operationId: first.operationId,
      leaseToken: leased.token,
      leaseGeneration: leased.generation,
      leaseExpiresAt: leased.leaseUntil,
      inputObjectDigest: first.inputDigest,
    });
  } catch (error) {
    await mapStoreError(reply, error);
  }
}
