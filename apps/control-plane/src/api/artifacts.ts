import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import {
  MissingBlobsRequestSchema,
  SnapshotCommitRequestSchema,
  type ObjectDigest,
} from "@pi-hec/contracts";
import { CasError } from "@pi-hec/cas";
import {
  buildExportManifest,
  isClassificationPermitted,
  type ArtifactClassification,
  type ExportableArtifact,
} from "@pi-hec/usage";
import { contentDigestSha256 } from "@pi-hec/security";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RunArtifactRecord } from "@pi-hec/state-store";
import {
  HttpSignal,
  artifactInputFromCas,
  asObjectDigest,
  jsonBuffer,
  mapStoreError,
  quotedEtag,
  requireScope,
  sendError,
  withIdempotency,
  type AppContext,
} from "../orchestration/handlers.js";

const MISSING = Compile(MissingBlobsRequestSchema);
const SNAPSHOT = Compile(SnapshotCommitRequestSchema);

function asDigest(value: string): ObjectDigest {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new HttpSignal(404, "NOT_FOUND", "not found");
  }
  return value as ObjectDigest;
}

export function filterArtifactsForProject(
  artifacts: readonly RunArtifactRecord[],
  permitted: ArtifactClassification,
): RunArtifactRecord[] {
  return artifacts.filter((artifact) => isClassificationPermitted(artifact.classification, permitted));
}

export function assembleExportManifest(input: {
  projectId: string;
  permittedClassification: ArtifactClassification;
  artifacts: readonly RunArtifactRecord[];
}) {
  const artifacts: ExportableArtifact[] = input.artifacts.map((row) => ({
    role: row.role,
    objectDigest: row.objectDigest,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    classification: row.classification,
    createdAt: row.createdAt,
  }));
  return buildExportManifest({
    projectId: input.projectId,
    permittedClassification: input.permittedClassification,
    artifacts,
  });
}

export async function missingBlobs(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const media = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (media !== "application/json") {
      await sendError(reply, 415, "MEDIA_TYPE_UNSUPPORTED", "json required");
      return;
    }
    if (!MISSING.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    const missing = request.body.objectDigests.filter((digest) => !ctx.store.hasArtifact(projectScope, asObjectDigest(digest)));
    void reply.header("cache-control", "no-store");
    await reply.code(200).send({ schemaVersion: 1, missingObjectDigests: missing });
  } catch (error) {
    await mapStoreError(reply, error);
  }
}

export async function putBlob(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const media = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (media !== "application/octet-stream") {
      throw new HttpSignal(415, "MEDIA_TYPE_UNSUPPORTED", "octet-stream required");
    }
    const raw = request.rawBody ?? Buffer.alloc(0);
    if (raw.byteLength > ctx.blobLimit) {
      throw new HttpSignal(413, "CONTENT_TOO_LARGE", "body too large");
    }
    const objectDigest = asDigest((request.params as { objectDigest: string }).objectDigest);
    const streamed = `sha256:${createHash("sha256").update(raw).digest("hex")}` as ObjectDigest;
    const digestHeader = request.headers["content-digest"];
    if (streamed !== objectDigest) {
      throw new HttpSignal(422, "CONTENT_DIGEST_MISMATCH", "digest mismatch");
    }
    if (typeof digestHeader !== "string" || digestHeader !== contentDigestSha256(raw)) {
      throw new HttpSignal(422, "CONTENT_DIGEST_MISMATCH", "digest mismatch");
    }
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    const result = await ctx.cas.putObject({
      projectId,
      bytes: raw,
      mediaType: "application/octet-stream",
      classification: "internal",
    });
    if (result.objectDigest !== objectDigest) {
      throw new HttpSignal(422, "CONTENT_DIGEST_MISMATCH", "digest mismatch");
    }
    const existed = ctx.store.hasArtifact(projectScope, objectDigest);
    if (!existed) {
      ctx.store.putArtifact(projectScope, artifactInputFromCas(ctx, result, ctx.clock(), null));
    }
    const location = `/v1/projects/${projectId}/blobs/sha256/${objectDigest}`;
    void reply.header("location", location).header("etag", quotedEtag(objectDigest)).header("repr-digest", contentDigestSha256(raw));
    if (existed || result.reusedExisting) {
      await reply.code(204).send();
      return;
    }
    await reply.code(201).send();
  } catch (error) {
    await mapStoreError(reply, error);
  }
}

export async function getBlob(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const objectDigest = asDigest((request.params as { objectDigest: string }).objectDigest);
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    if (!ctx.store.hasArtifact(projectScope, objectDigest)) {
      throw new HttpSignal(404, "NOT_FOUND", "not found");
    }
    const artifact = ctx.store.getArtifact(projectScope, objectDigest);
    const project = ctx.store.getProject(scope, projectId);
    if (
      artifact === undefined ||
      !isClassificationPermitted(artifact.classification, project.classification)
    ) {
      throw new HttpSignal(404, "NOT_FOUND", "not found");
    }
    const bytes = await ctx.cas.getObject({ projectId, objectDigest });
    const etag = quotedEtag(objectDigest);
    const fullDigest = contentDigestSha256(bytes);
    void reply
      .header("etag", etag)
      .header("accept-ranges", "bytes")
      .header("cache-control", "no-store")
      .header("repr-digest", fullDigest);
    const noneMatch = request.headers["if-none-match"];
    if (typeof noneMatch === "string" && noneMatch === etag) {
      await reply.code(304).send();
      return;
    }
    const range = request.headers.range;
    if (typeof range === "string") {
      if (range.includes(",")) {
        throw new HttpSignal(416, "RANGE_NOT_SATISFIABLE", "multi-range rejected");
      }
      const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (match === null) {
        throw new HttpSignal(416, "RANGE_NOT_SATISFIABLE", "range unsatisfiable");
      }
      const start = Number.parseInt(match[1] ?? "0", 10);
      const end = match[2] === undefined ? bytes.byteLength - 1 : Number.parseInt(match[2], 10);
      if (start > end || start >= bytes.byteLength || end >= bytes.byteLength) {
        throw new HttpSignal(416, "RANGE_NOT_SATISFIABLE", "range unsatisfiable");
      }
      const slice = bytes.subarray(start, end + 1);
      void reply
        .header("content-range", `bytes ${String(start)}-${String(end)}/${String(bytes.byteLength)}`)
        .header("content-digest", contentDigestSha256(slice))
        .type("application/octet-stream");
      await reply.code(206).send(Buffer.from(slice));
      return;
    }
    void reply.header("content-digest", fullDigest).type("application/octet-stream");
    await reply.code(200).send(Buffer.from(bytes));
  } catch (error) {
    if (error instanceof CasError && error.code === "NOT_FOUND") {
      await mapStoreError(reply, new HttpSignal(404, "NOT_FOUND", "not found"));
      return;
    }
    await mapStoreError(reply, error);
  }
}

export async function commitSnapshot(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    if (!SNAPSHOT.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const snapshotId = (request.params as { snapshotId: string }).snapshotId;
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    const now = ctx.clock();
    const manifestBytes = jsonBuffer(request.body.manifest);
    const put = await ctx.cas.putObject({
      projectId,
      bytes: manifestBytes,
      mediaType: "application/json",
      classification: "internal",
      schemaName: "SnapshotManifest",
    });
    if (!ctx.store.hasArtifact(projectScope, put.objectDigest)) {
      ctx.store.putArtifact(projectScope, artifactInputFromCas(ctx, put, now, "SnapshotManifest"));
    }
    try {
      ctx.store.createSnapshot(projectScope, {
        snapshotId,
        workspaceId: request.body.manifest.payload.workspaceId,
        rootDigest: request.body.manifest.payload.rootDigest as ObjectDigest,
        manifestDigest: put.objectDigest,
        runnerId: request.body.manifest.payload.runnerId,
        createdAt: now,
      });
    } catch {
      const existing = ctx.store.getSnapshot(projectScope, snapshotId);
      return {
        status: 200,
        headers: { location: `/v1/projects/${projectId}/snapshots/${snapshotId}`, etag: quotedEtag(existing.rootDigest) },
        body: jsonBuffer({
          schemaVersion: 1,
          projectId: existing.projectId,
          workspaceId: existing.workspaceId,
          snapshotId: existing.snapshotId,
          rootDigest: existing.rootDigest,
          manifestObjectDigest: existing.manifestDigest,
          runnerId: existing.runnerId,
          createdAt: existing.createdAt,
        }),
      };
    }
    const stored = ctx.store.getSnapshot(projectScope, snapshotId);
    return {
      status: 201,
      headers: { location: `/v1/projects/${projectId}/snapshots/${snapshotId}`, etag: quotedEtag(stored.rootDigest) },
      body: jsonBuffer({
        schemaVersion: 1,
        projectId: stored.projectId,
        workspaceId: stored.workspaceId,
        snapshotId: stored.snapshotId,
        rootDigest: stored.rootDigest,
        manifestObjectDigest: stored.manifestDigest,
        runnerId: stored.runnerId,
        createdAt: stored.createdAt,
      }),
    };
  });
}
