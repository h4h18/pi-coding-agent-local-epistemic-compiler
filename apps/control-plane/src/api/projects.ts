import { Compile } from "typebox/compile";
import {
  CreateProjectRequestSchema,
  CreateWorkspaceRequestSchema,
  ProjectPolicySchema,
  ProjectProjectionSchema,
  SetProjectTrustRequestSchema,
  UpdateProjectPolicyRequestSchema,
  type CreateProjectRequest,
} from "@pi-hec/contracts";
import { StateVersionConflictError } from "@pi-hec/state-store";
import { type Static } from "typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  HttpSignal,
  artifactInputFromCas,
  asObjectDigest,
  digestLabel,
  jsonBuffer,
  mapStoreError,
  newApprovalId,
  persistCasArtifact,
  putBytes,
  quotedEtag,
  requireMatchingStateVersion,
  requireScope,
  withIdempotency,
  type AppContext,
} from "../orchestration/handlers.js";

const CREATE = Compile(CreateProjectRequestSchema);
const POLICY = Compile(ProjectPolicySchema);
const UPDATE_POLICY = Compile(UpdateProjectPolicyRequestSchema);
const SET_TRUST = Compile(SetProjectTrustRequestSchema);
const WORKSPACE = Compile(CreateWorkspaceRequestSchema);

type ProjectProjection = Static<typeof ProjectProjectionSchema>;

function asCreate(body: unknown): CreateProjectRequest {
  if (!CREATE.Check(body)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
  }
  return body;
}

export async function createProject(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    const body = asCreate(request.body);
    if (body.policy.payload.projectId !== body.projectId) {
      throw new HttpSignal(422, "DOMAIN_INVARIANT_FAILED", "policy projectId mismatch");
    }
    if (body.policy.payload.classification !== body.classification) {
      throw new HttpSignal(422, "DOMAIN_INVARIANT_FAILED", "classification mismatch");
    }
    if (!POLICY.Check(body.policy.payload)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "policy invalid");
    }
    const scope = requireScope(request);
    const now = ctx.clock();
    const extra = digestLabel(`grant:${body.projectId}`);
    const scoped = {
      ...scope,
      projectGrants: [
        ...scope.projectGrants,
        { projectId: body.projectId, roles: ["admin"], grantObjectDigest: extra },
      ],
    };
    const policyBytes = jsonBuffer(body.policy);
    const put = await putBytes(ctx, body.projectId, policyBytes, "application/json", body.classification, "ProjectPolicy");
    ctx.store.createUntrustedProject(scoped, {
      projectId: body.projectId,
      displayName: body.displayName,
      classification: body.classification,
      policy: artifactInputFromCas(ctx, put, now, "ProjectPolicy"),
      createdAt: now,
    });
    const project = ctx.store.getProject(scoped, body.projectId);
    const challengeId = newApprovalId();
    const challenge = {
      schemaVersion: 1 as const,
      approvalId: challengeId,
      projectId: body.projectId,
      scope: { kind: "project" as const },
      action: "project-trust" as const,
      subjectObjectDigest: put.objectDigest,
      policyObjectDigest: ctx.hostPolicyDigest,
      nonce: now,
      expiresAt: new Date(Date.parse(now) + 3600_000).toISOString(),
      displayArtifactObjectDigest: put.objectDigest,
    };
    const envelope = {
      schemaName: "ApprovalChallenge",
      schemaVersion: 1,
      payload: challenge,
      payloadDigest: put.objectDigest,
      signatures: [],
    };
    const projection: ProjectProjection = {
      schemaVersion: 1,
      projectId: project.projectId,
      displayName: project.displayName,
      trustState: project.trustState,
      classification: project.classification,
      policyObjectDigest: project.policyDigest as ProjectProjection["policyObjectDigest"],
      stateVersion: project.stateVersion,
    };
    const response = { schemaVersion: 1 as const, project: projection, trustChallenge: envelope };
    const bodyBytes = jsonBuffer(response);
    return {
      status: 201,
      headers: {
        location: `/v1/projects/${body.projectId}`,
        etag: quotedEtag(project.stateVersion),
      },
      body: bodyBytes,
    };
  });
}

export async function getProject(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const project = ctx.store.getProject(scope, projectId);
    const etag = quotedEtag(project.stateVersion);
    const noneMatch = request.headers["if-none-match"];
    void reply.header("etag", etag).header("cache-control", "no-store");
    if (typeof noneMatch === "string" && noneMatch === etag) {
      await reply.code(304).send();
      return;
    }
    const projection: ProjectProjection = {
      schemaVersion: 1,
      projectId: project.projectId,
      displayName: project.displayName,
      trustState: project.trustState,
      classification: project.classification,
      policyObjectDigest: project.policyDigest as ProjectProjection["policyObjectDigest"],
      stateVersion: project.stateVersion,
    };
    await reply.code(200).send(projection);
  } catch (error) {
    await mapStoreError(reply, error);
  }
}

export async function updateProjectPolicy(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    if (!UPDATE_POLICY.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const ifMatch = request.headers["if-match"];
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const current = ctx.store.getProject(scope, projectId);
    requireMatchingStateVersion(ifMatch, current.stateVersion);
    const now = ctx.clock();
    const body = request.body;
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    const subject = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      jsonBuffer({ kind: "policy-subject", projectId, approvalId: body.approvalId }),
      "application/json",
      "internal",
      "ApprovalSubject",
    );
    const display = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      jsonBuffer({ kind: "policy-display", projectId, approvalId: body.approvalId }),
      "application/json",
      "internal",
      "ApprovalChallenge",
    );
    const challenge = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      jsonBuffer({ kind: "policy-challenge", projectId, approvalId: body.approvalId }),
      "application/json",
      "internal",
      "ApprovalChallenge",
    );
    const decision = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      jsonBuffer({ kind: "policy-decision", projectId, approvalId: body.approvalId }),
      "application/json",
      "internal",
      "ApprovalDecision",
    );
    const grant = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      jsonBuffer({ kind: "policy-grant", projectId, approvalId: body.approvalId }),
      "application/json",
      "internal",
      "ApprovalGrant",
    );
    const expiresAt = new Date(Date.parse(now) + 3600_000).toISOString();
    ctx.store.insertOpenApprovalChallenge(projectScope, {
      approvalId: body.approvalId,
      runId: undefined,
      action: "project-policy",
      principalId: scope.principalId,
      subjectDigest: subject,
      policyDigest: ctx.hostPolicyDigest,
      displayArtifactDigest: display,
      challengeDigest: challenge,
      nonceHash: digestLabel(`nonce:policy:${body.approvalId}`),
      expiresAt,
      createdAt: now,
    });
    ctx.store.consumeApprovalChallenge(projectScope, {
      approvalId: body.approvalId,
      challengeDigest: challenge,
      decisionDigest: decision,
      grantDigest: grant,
      outcome: "approved",
      consumedAt: now,
      expiresAt,
    });
    const policyBytes = jsonBuffer(body.policy);
    const put = await putBytes(
      ctx,
      projectId,
      policyBytes,
      "application/json",
      body.policy.payload.classification,
      "ProjectPolicy",
    );
    const policy = artifactInputFromCas(ctx, put, now, "ProjectPolicy");
    let project;
    try {
      project = ctx.store.updateProjectPolicy(scope, {
        projectId,
        policy,
        approvalId: body.approvalId,
        expectedStateVersion: current.stateVersion,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed/i.test(error.message)) {
        throw new StateVersionConflictError();
      }
      throw error;
    }
    const projection: ProjectProjection = {
      schemaVersion: 1,
      projectId: project.projectId,
      displayName: project.displayName,
      trustState: project.trustState,
      classification: project.classification,
      policyObjectDigest: project.policyDigest as ProjectProjection["policyObjectDigest"],
      stateVersion: project.stateVersion,
    };
    return {
      status: 200,
      headers: { etag: quotedEtag(project.stateVersion) },
      body: jsonBuffer(projection),
    };
  });
}

export async function setProjectTrust(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    if (!SET_TRUST.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const ifMatch = request.headers["if-match"];
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const current = ctx.store.getProject(scope, projectId);
    requireMatchingStateVersion(ifMatch, current.stateVersion);
    const now = ctx.clock();
    const body = request.body;
    const subject = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      jsonBuffer({ kind: "trust-subject", projectId, trustState: body.trustState }),
      "application/json",
      "internal",
      "ApprovalSubject",
    );
    const display = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      jsonBuffer({ kind: "trust-display", projectId }),
      "application/json",
      "internal",
      "ApprovalChallenge",
    );
    const challenge = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      jsonBuffer({ kind: "trust-challenge", projectId }),
      "application/json",
      "internal",
      "ApprovalChallenge",
    );
    const decision = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      jsonBuffer({ kind: "trust-decision", projectId }),
      "application/json",
      "internal",
      "ApprovalDecision",
    );
    const grant = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      jsonBuffer({ kind: "trust-grant", projectId }),
      "application/json",
      "internal",
      "ApprovalGrant",
    );
    ctx.store.setProjectTrust(scope, {
      projectId,
      nextTrustState: body.trustState,
      approvalId: body.approvalId,
      principalId: scope.principalId,
      subjectDigest: subject,
      hostPolicyDigest: ctx.hostPolicyDigest,
      challengeDigest: challenge,
      decisionDigest: decision,
      grantDigest: grant,
      displayArtifactDigest: display,
      nonceHash: digestLabel(`nonce:${projectId}:${now}`),
      expiresAt: new Date(Date.parse(now) + 3600_000).toISOString(),
      createdAt: now,
      consumedAt: now,
      outcome: "approved",
    });
    const project = ctx.store.getProject(scope, projectId);
    const projection: ProjectProjection = {
      schemaVersion: 1,
      projectId: project.projectId,
      displayName: project.displayName,
      trustState: project.trustState,
      classification: project.classification,
      policyObjectDigest: project.policyDigest as ProjectProjection["policyObjectDigest"],
      stateVersion: project.stateVersion,
    };
    return { status: 200, headers: { etag: quotedEtag(project.stateVersion) }, body: jsonBuffer(projection) };
  });
}

export async function createWorkspace(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    if (!WORKSPACE.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const ifMatch = request.headers["if-match"];
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const current = ctx.store.getProject(scope, projectId);
    requireMatchingStateVersion(ifMatch, current.stateVersion);
    const now = ctx.clock();
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    ctx.store.createWorkspace(projectScope, {
      workspaceId: request.body.workspaceId,
      runnerId: request.body.runnerId,
      rootFingerprint: request.body.rootFingerprint,
      platform: request.body.platform,
      brokerAttestationDigest: asObjectDigest(request.body.brokerAttestationObjectDigest),
      registrationGrantDigest: asObjectDigest(request.body.brokerAttestationObjectDigest),
      createdAt: now,
    });
    const ws = ctx.store.getWorkspace(projectScope, request.body.workspaceId);
    return {
      status: 201,
      headers: {
        location: `/v1/projects/${projectId}/workspaces/${ws.workspaceId}`,
        etag: quotedEtag(ws.stateVersion),
      },
      body: jsonBuffer({
        schemaVersion: 1,
        projectId: ws.projectId,
        workspaceId: ws.workspaceId,
        runnerId: ws.runnerId,
        rootFingerprint: ws.rootFingerprint,
        platform: ws.platform,
        registrationApprovalGrantObjectDigest: ws.registrationGrantDigest,
        recoveryState: ws.recoveryState,
        stateVersion: ws.stateVersion,
      }),
    };
  });
}
