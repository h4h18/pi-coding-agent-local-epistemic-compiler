import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ControlPlaneClient, jsonBody, type ClientResponse } from "@pi-hec/client";
import {
  objectDigestFromBytes,
  randomPrefixedUuidV7,
  SnapshotManifestSchema,
  asObjectDigest,
  asSnapshotId,
  isObjectDigest,
  isSnapshotId,
  type ObjectDigest,
  type SnapshotEntry,
  type SnapshotId,
  type SnapshotManifest,
} from "@pi-hec/contracts";
import { snapshotRootDigest, unicodeSimpleFoldTableDigest } from "@pi-hec/repository";
import { contentDigestSha256 } from "@pi-hec/security";
import { Compile } from "typebox/compile";

const MANIFEST = Compile(SnapshotManifestSchema);

export const FAEX1_HOST_RUNNER_ID = "faex1-host-runner";

export type HostRunnerLease = {
  projectId: string;
  operationId: string;
  leaseToken: string;
  leaseGeneration: number;
  inputObjectDigest: ObjectDigest;
};

export type HostRunnerLeaseOutcome =
  | { outcome: "NO_JOB"; retryAfterMs: number }
  | { outcome: "LEASED"; job: HostRunnerLease };

function parseJson(body: Buffer): unknown {
  return JSON.parse(body.toString("utf8")) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} missing`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} missing`);
  }
  return value;
}

function assertOk(response: ClientResponse, label: string): void {
  if (response.status >= 400) {
    throw new Error(`${label} failed: ${String(response.status)} ${response.body.toString("utf8")}`);
  }
}

function posixFrom(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function walkWorkspaceFiles(root: string): readonly string[] {
  const collected: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === ".git" || entry === "node_modules") {
        continue;
      }
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        visit(full);
        continue;
      }
      if (stat.isFile()) {
        collected.push(full);
      }
    }
  };
  visit(root);
  return collected;
}

async function putBytes(
  client: ControlPlaneClient,
  projectId: string,
  bytes: Buffer,
): Promise<ObjectDigest> {
  const objectDigest = objectDigestFromBytes(bytes);
  const stored = await client.call({
    operationId: "putBlob",
    pathParams: { projectId, objectDigest },
    body: bytes,
    headers: {
      "content-type": "application/octet-stream",
      "content-digest": contentDigestSha256(bytes),
    },
  });
  if (stored.status !== 201 && stored.status !== 204) {
    throw new Error(`putBlob failed: ${String(stored.status)} ${stored.body.toString("utf8")}`);
  }
  return objectDigest;
}

async function putJson(
  client: ControlPlaneClient,
  projectId: string,
  value: unknown,
): Promise<ObjectDigest> {
  return putBytes(client, projectId, Buffer.from(JSON.stringify(value), "utf8"));
}

function platformMetadata(pathName: string, bytes: Buffer): SnapshotEntry["platformMetadata"] {
  if (process.platform === "win32") {
    return {
      kind: "windows",
      fileId: pathName,
      securityDescriptorDigest: objectDigestFromBytes(bytes),
      alternateStreams: [],
    };
  }
  return {
    kind: "posix",
    device: "dev1",
    inode: pathName,
    mode: 33188,
    ownerId: 0,
    groupId: 0,
    xattrsDigest: objectDigestFromBytes(bytes),
  };
}

function filesystemPlatform(): SnapshotManifest["filesystem"]["platform"] {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}

function buildManifest(input: {
  snapshotId: SnapshotId;
  projectId: string;
  workspaceId: string;
  runnerId: string;
  createdAt: string;
  entries: SnapshotEntry[];
}): SnapshotManifest {
  const filesystem = {
    platform: filesystemPlatform(),
    rootChildNameComparison:
      process.platform === "win32" ? ("case-insensitive" as const) : ("case-sensitive" as const),
    unicodeNormalization: "NFC" as const,
    unicodeSimpleFoldTableObjectDigest: unicodeSimpleFoldTableDigest(),
    pathGlobDialect: "pi-hec-pathglob/v1" as const,
    volumeIdentity: input.workspaceId,
  };
  const draft: SnapshotManifest = {
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    repositoryId: input.projectId,
    workspaceId: input.workspaceId,
    dirty: true,
    filesystem,
    entries: input.entries,
    ignoredPathDigests: [],
    excludedPaths: [],
    rootDigest: objectDigestFromBytes(Buffer.from("pending", "utf8")),
    createdAt: input.createdAt,
    runnerId: input.runnerId,
  };
  const manifest: SnapshotManifest = {
    ...draft,
    rootDigest: snapshotRootDigest(draft),
  };
  if (!MANIFEST.Check(manifest)) {
    throw new Error("snapshot manifest schema invalid");
  }
  return manifest;
}

export async function leaseHostRunnerJob(input: {
  client: ControlPlaneClient;
  runnerId: string;
  capabilitiesObjectDigest: string;
}): Promise<HostRunnerLeaseOutcome> {
  const response = await input.client.call({
    operationId: "leaseRunnerJob",
    body: jsonBody({
      schemaVersion: 1,
      runnerId: input.runnerId,
      capabilitiesObjectDigest: input.capabilitiesObjectDigest,
      maxJobs: 1,
    }),
    headers: { "content-type": "application/json" },
  });
  assertOk(response, "leaseRunnerJob");
  const record = asRecord(parseJson(response.body), "lease");
  const outcome = requireString(record, "outcome");
  if (outcome === "NO_JOB") {
    const retryAfterMs = record.retryAfterMs;
    return {
      outcome: "NO_JOB",
      retryAfterMs: typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? retryAfterMs : 2000,
    };
  }
  if (outcome !== "LEASED") {
    throw new Error(`unhandled lease outcome ${outcome}`);
  }
  const digest = requireString(record, "inputObjectDigest");
  if (!isObjectDigest(digest)) {
    throw new Error("lease input digest missing");
  }
  return {
    outcome: "LEASED",
    job: {
      projectId: requireString(record, "projectId"),
      operationId: requireString(record, "operationId"),
      leaseToken: requireString(record, "leaseToken"),
      leaseGeneration: requireNumber(record, "leaseGeneration"),
      inputObjectDigest: asObjectDigest(digest),
    },
  };
}

export async function executeLeasedCaptureJob(input: {
  client: ControlPlaneClient;
  job: HostRunnerLease;
  workspaceRootById: Readonly<Record<string, string>>;
  runnerId: string;
  now: () => string;
}): Promise<void> {
  const got = await input.client.call({
    operationId: "getOperation",
    pathParams: { projectId: input.job.projectId, operationId: input.job.operationId },
  });
  assertOk(got, "getOperation");
  const operation = asRecord(parseJson(got.body), "operation");
  if (requireString(operation, "kind") !== "CAPTURE_SNAPSHOT") {
    throw new Error(`unexpected runner kind ${requireString(operation, "kind")}`);
  }
  const blob = await input.client.call({
    operationId: "getBlob",
    pathParams: { projectId: input.job.projectId, objectDigest: input.job.inputObjectDigest },
  });
  assertOk(blob, "getBlob");
  const payload = asRecord(parseJson(blob.body), "capture-input");
  const workspaceId = requireString(payload, "workspaceId");
  const workspaceRoot = input.workspaceRootById[workspaceId];
  if (workspaceRoot === undefined) {
    throw new Error(`workspace root missing for ${workspaceId}`);
  }
  const snapshotId = asSnapshotId(randomPrefixedUuidV7("snap_"));
  const entries: SnapshotEntry[] = [];
  for (const filePath of walkWorkspaceFiles(workspaceRoot)) {
    const relative = posixFrom(workspaceRoot, filePath);
    const bytes = readFileSync(filePath);
    const stored = await putBytes(input.client, input.job.projectId, bytes);
    entries.push({
      path: relative,
      platformMetadata: platformMetadata(relative, bytes),
      entryType: "file",
      contentDigest: stored,
      size: statSync(filePath).size,
      gitMode: "100644",
      storage: { kind: "blob", objectDigest: stored },
    });
  }
  const manifest = buildManifest({
    snapshotId,
    projectId: input.job.projectId,
    workspaceId,
    runnerId: input.runnerId,
    createdAt: input.now(),
    entries,
  });
  const manifestObjectDigest = await putJson(input.client, input.job.projectId, manifest);
  const resultObjectDigest = await putJson(input.client, input.job.projectId, {
    schemaVersion: 1,
    snapshotId,
    manifestObjectDigest,
    rootDigest: manifest.rootDigest,
    workspaceRoot,
  });
  if (!isSnapshotId(snapshotId)) {
    throw new Error("snapshot id invalid");
  }
  const completed = await input.client.call({
    operationId: "completeOperation",
    pathParams: { projectId: input.job.projectId, operationId: input.job.operationId },
    body: jsonBody({
      schemaVersion: 1,
      leaseToken: input.job.leaseToken,
      leaseGeneration: input.job.leaseGeneration,
      outcome: "SUCCEEDED",
      resultObjectDigest,
    }),
    headers: { "content-type": "application/json" },
  });
  assertOk(completed, "completeOperation");
}

export async function drainHostRunnerUntilIdle(input: {
  client: ControlPlaneClient;
  runnerId: string;
  capabilitiesObjectDigest: string;
  workspaceRootById: Readonly<Record<string, string>>;
  now?: () => string;
  maxJobs?: number;
}): Promise<number> {
  const limit = input.maxJobs ?? 8;
  const now = input.now ?? (() => new Date().toISOString());
  let executed = 0;
  for (let wave = 0; wave < limit; wave += 1) {
    const leased = await leaseHostRunnerJob({
      client: input.client,
      runnerId: input.runnerId,
      capabilitiesObjectDigest: input.capabilitiesObjectDigest,
    });
    if (leased.outcome === "NO_JOB") {
      return executed;
    }
    await executeLeasedCaptureJob({
      client: input.client,
      job: leased.job,
      workspaceRootById: input.workspaceRootById,
      runnerId: input.runnerId,
      now,
    });
    executed += 1;
  }
  throw new Error("host runner drain saturated");
}
