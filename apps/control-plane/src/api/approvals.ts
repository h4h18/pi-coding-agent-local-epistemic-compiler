import { Compile } from "typebox/compile";
import {
  ApprovalChallengeRequestSchema,
  ApprovalChallengeSchema,
  ApprovalSubjectSchema,
  CommitApprovalRequestSchema,
  asPayloadDigest,
  type ApprovalSubject,
  type CommitApprovalRequest,
  type ObjectDigest,
  type PrincipalScope,
} from "@pi-hec/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CasError } from "@pi-hec/cas";
import {
  ApprovalError,
  approvalObjectDigest,
  freshApprovalNonce,
  issueGrantIfFaActive,
  type ApprovalChallenge,
  type SignedApprovalDecision,
  type SignedApprovalGrant,
} from "@pi-hec/security";
import {
  HttpSignal,
  asObjectDigest,
  digestLabel,
  jsonBuffer,
  newApprovalId,
  persistCasArtifact,
  requireMatchingStateVersion,
  requireScope,
  withIdempotency,
  type AppContext,
} from "../orchestration/handlers.js";

const CHALLENGE = Compile(ApprovalChallengeRequestSchema);
const COMMIT = Compile(CommitApprovalRequestSchema);
const SUBJECT = Compile(ApprovalSubjectSchema);
const STORED_CHALLENGE = Compile(ApprovalChallengeSchema);

async function loadJson(
  ctx: AppContext,
  projectId: string,
  digest: ObjectDigest,
): Promise<unknown> {
  try {
    const bytes = await ctx.cas.getObject({ projectId, objectDigest: digest });
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof CasError) {
      throw new HttpSignal(404, "NOT_FOUND", "not found");
    }
    throw error;
  }
}

function requireSubject(value: unknown): ApprovalSubject {
  if (!SUBJECT.Check(value)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
  }
  return value;
}

function requireStoredChallenge(value: unknown): ApprovalChallenge {
  if (value === null || typeof value !== "object") {
    throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
  }
  const record = value as { payload?: unknown };
  const payload = record.payload ?? value;
  if (!STORED_CHALLENGE.Check(payload)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
  }
  return {
    ...payload,
    subjectObjectDigest: asObjectDigest(payload.subjectObjectDigest),
    policyObjectDigest: asObjectDigest(payload.policyObjectDigest),
    displayArtifactObjectDigest: asObjectDigest(payload.displayArtifactObjectDigest),
  };
}

function requireSignedDecision(
  decision: CommitApprovalRequest["decision"],
): SignedApprovalDecision {
  return { ...decision, payloadDigest: asPayloadDigest(decision.payloadDigest) };
}

function requireFaRunnerId(
  ctx: AppContext,
  scope: PrincipalScope,
  subject: ApprovalSubject,
): string {
  const bound = ctx.store.getRunnerByPrincipalId(scope.principalId);
  if (bound !== undefined) {
    return bound.runnerId;
  }
  if ("runnerId" in subject) {
    return subject.runnerId;
  }
  throw new HttpSignal(401, "AUTHENTICATION_FAILED", "authentication failed");
}

function mapGrantError(error: unknown): never {
  if (error instanceof ApprovalError) {
    if (error.reason === "revoked") {
      throw new HttpSignal(401, "AUTHENTICATION_FAILED", "authentication failed");
    }
    if (error.reason === "signature-missing") {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    throw new HttpSignal(400, "SCHEMA_INVALID", error.reason);
  }
  throw error;
}

async function createChallenge(
  ctx: AppContext,
  request: FastifyRequest,
  runId: string | undefined,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  if (!CHALLENGE.Check(request.body)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
  }
  const scope = requireScope(request);
  const projectId = (request.params as { projectId: string }).projectId;
  const now = ctx.clock();
  const approvalId = newApprovalId();
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  const subjectCasDigest = asObjectDigest(request.body.subjectObjectDigest);
  const subject = requireSubject(await loadJson(ctx, projectId, subjectCasDigest));
  const nonce = freshApprovalNonce();
  const challengePayload: ApprovalChallenge = {
    schemaVersion: 1,
    approvalId,
    projectId,
    scope: runId === undefined ? { kind: "project" } : { kind: "run", runId },
    action: request.body.action,
    subjectObjectDigest: approvalObjectDigest("ApprovalSubject", subject),
    policyObjectDigest: ctx.hostPolicyDigest,
    nonce,
    expiresAt: new Date(Date.parse(now) + 3600_000).toISOString(),
    displayArtifactObjectDigest: subjectCasDigest,
  };
  const envelope = {
    schemaName: "ApprovalChallenge",
    schemaVersion: 1,
    payload: challengePayload,
    payloadDigest: approvalObjectDigest("ApprovalChallenge", challengePayload),
    signatures: [],
  };
  const body = jsonBuffer(envelope);
  const challengeDigest = await persistCasArtifact(
    ctx,
    scope,
    projectId,
    body,
    "application/json",
    "internal",
    "ApprovalChallenge",
  );
  ctx.store.insertOpenApprovalChallenge(projectScope, {
    approvalId,
    runId,
    action: request.body.action,
    principalId: scope.principalId,
    subjectDigest: subjectCasDigest,
    policyDigest: ctx.hostPolicyDigest,
    displayArtifactDigest: subjectCasDigest,
    challengeDigest,
    nonceHash: digestLabel(nonce),
    expiresAt: challengePayload.expiresAt,
    createdAt: now,
  });
  const location =
    runId === undefined
      ? `/v1/projects/${projectId}/approvals/${approvalId}`
      : `/v1/projects/${projectId}/runs/${runId}/approvals/${approvalId}`;
  return { status: 201, headers: { location }, body };
}

export async function createProjectApprovalChallenge(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () =>
    createChallenge(ctx, request, undefined),
  );
}

export async function createRunApprovalChallenge(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    const ifMatch = request.headers["if-match"];
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const runId = (request.params as { runId: string }).runId;
    const run = ctx.store.getRun(ctx.store.toProjectScope(scope, projectId), runId);
    requireMatchingStateVersion(ifMatch, run.stateVersion);
    return createChallenge(ctx, request, runId);
  });
}

function mintGrant(
  ctx: AppContext,
  scope: PrincipalScope,
  decision: SignedApprovalDecision,
  challenge: ApprovalChallenge,
  subject: ApprovalSubject,
): SignedApprovalGrant {
  const uiKeyId = decision.signatures[0]?.keyId;
  if (uiKeyId === undefined) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
  }
  const uiPublicKey = ctx.signingKeys.get(uiKeyId);
  if (uiPublicKey === undefined) {
    throw new HttpSignal(401, "AUTHENTICATION_FAILED", "authentication failed");
  }
  try {
    return issueGrantIfFaActive({
      decision,
      challenge,
      subject,
      uiPublicKey,
      uiKeyId,
      brokerPrivateKey: ctx.brokerPrivateKey,
      brokerKeyId: ctx.brokerKeyId,
      brokerCertificateObjectDigest: ctx.brokerCertificateObjectDigest,
      authenticatedPrincipalId: scope.principalId,
      nonceRegistry: ctx.approvalNonces,
      now: ctx.clock(),
      store: ctx.store,
      faRunnerId: requireFaRunnerId(ctx, scope, subject),
    });
  } catch (error) {
    mapGrantError(error);
  }
}

async function commitApproval(
  ctx: AppContext,
  request: FastifyRequest,
  runId: string | undefined,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  if (!COMMIT.Check(request.body)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
  }
  const scope = requireScope(request);
  const projectId = (request.params as { projectId: string }).projectId;
  const approvalId = (request.params as { approvalId: string }).approvalId;
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  const now = ctx.clock();
  const challengeDigest = asObjectDigest(request.body.challengeObjectDigest);
  const challenge = requireStoredChallenge(await loadJson(ctx, projectId, challengeDigest));
  const subject = requireSubject(
    await loadJson(ctx, projectId, challenge.displayArtifactObjectDigest),
  );
  const decision = requireSignedDecision(request.body.decision);
  const decisionDigest = await persistCasArtifact(
    ctx,
    scope,
    projectId,
    jsonBuffer(decision),
    "application/json",
    "internal",
    "ApprovalDecision",
  );
  let grant: SignedApprovalGrant;
  try {
    grant = mintGrant(ctx, scope, decision, challenge, subject);
  } catch (error) {
    if (
      decision.payload.decision === "DENY" &&
      error instanceof HttpSignal &&
      error.message === "denied"
    ) {
      ctx.store.consumeApprovalChallenge(projectScope, {
        approvalId,
        challengeDigest,
        decisionDigest,
        grantDigest: decisionDigest,
        outcome: "denied",
        consumedAt: now,
        expiresAt: decision.payload.expiresAt,
      });
      void runId;
      return {
        status: 200,
        headers: {},
        body: jsonBuffer({
          schemaVersion: 1,
          outcome: "DENIED",
          decisionObjectDigest: decisionDigest,
        }),
      };
    }
    throw error;
  }
  const grantBytes = jsonBuffer(grant);
  const grantDigest = await persistCasArtifact(
    ctx,
    scope,
    projectId,
    grantBytes,
    "application/json",
    "internal",
    "ApprovalGrant",
  );
  ctx.store.consumeApprovalChallenge(projectScope, {
    approvalId,
    challengeDigest,
    decisionDigest,
    grantDigest,
    outcome: "approved",
    consumedAt: now,
    expiresAt: decision.payload.expiresAt,
  });
  void runId;
  return {
    status: 201,
    headers: { location: `/v1/projects/${projectId}/approvals/${approvalId}` },
    body: jsonBuffer({
      schemaVersion: 1,
      outcome: "APPROVED",
      decisionObjectDigest: decisionDigest,
      grant,
    }),
  };
}

export async function commitProjectApproval(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () =>
    commitApproval(ctx, request, undefined),
  );
}

export async function commitRunApproval(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    const ifMatch = request.headers["if-match"];
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const runId = (request.params as { runId: string }).runId;
    const run = ctx.store.getRun(ctx.store.toProjectScope(scope, projectId), runId);
    requireMatchingStateVersion(ifMatch, run.stateVersion);
    return commitApproval(ctx, request, runId);
  });
}
