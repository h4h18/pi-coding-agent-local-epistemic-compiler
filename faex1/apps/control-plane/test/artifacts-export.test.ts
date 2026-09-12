import { afterAll, beforeAll, expect, test } from "vitest";
import type { ObjectDigest } from "@pi-hec/contracts";
import { constructPrincipalScope } from "@pi-hec/security";
import type { RunArtifactRecord } from "@pi-hec/state-store";
import { assembleExportManifest, filterArtifactsForProject } from "../src/api/artifacts.js";
import { HOST_GRANT_POLICY, PROJECT_ID, digestOf, startHarness, type Harness } from "./harness.js";

const PUBLIC = `sha256:${"aa".repeat(32)}` as ObjectDigest;
const RESTRICTED = `sha256:${"bb".repeat(32)}` as ObjectDigest;

function artifact(
  digest: ObjectDigest,
  classification: RunArtifactRecord["classification"],
): RunArtifactRecord {
  return {
    role: "task-envelope",
    objectDigest: digest,
    mediaType: "application/json",
    byteSize: 4,
    classification,
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

test("artifact page export drops restricted bytes and never returns 403", () => {
  const artifacts = [artifact(PUBLIC, "public"), artifact(RESTRICTED, "restricted")];
  const visible = filterArtifactsForProject(artifacts, "internal");
  expect(visible.map((row) => row.objectDigest)).toEqual([PUBLIC]);
  const manifest = assembleExportManifest({
    projectId: "proj-alpha",
    permittedClassification: "internal",
    artifacts,
  });
  expect(manifest.artifactObjectDigests).toEqual([PUBLIC]);
  expect("httpStatus" in manifest).toBe(false);
  expect("deniedAs" in manifest).toBe(false);
});

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
  }
});

test("restricted getBlob is 404 and never 403", async () => {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  const now = harness.clock();
  const scope = constructPrincipalScope({
    record: harness.listening.ctx.hostAdminRecord,
    grants: [
      {
        projectId: PROJECT_ID,
        roles: ["admin"],
        grantObjectDigest: HOST_GRANT_POLICY,
        revokedAt: undefined,
      },
    ],
    authenticatedAt: now,
  });
  const projectScope = harness.store.toProjectScope(scope, PROJECT_ID);
  const restricted = digestOf("restricted-blob-task-22");
  harness.store.putArtifact(projectScope, {
    digest: restricted,
    schemaName: null,
    mediaType: "application/octet-stream",
    byteSize: 8,
    classification: "restricted",
    encryptionAlgorithm: "AES-256-GCM",
    encryptionKeyId: "cas:restricted-blob",
    encryptionNonce: "000000000000000000000099",
    storageRecordDigest: digestOf("storage-restricted-blob"),
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: now,
    storageRecordSignerCertificateDigest: digestOf("host-signer-cert"),
    storageRecordSignature: "c2ln",
    createdAt: now,
  });
  const response = await harness.broker.call({
    operationId: "getBlob",
    pathParams: { projectId: PROJECT_ID, objectDigest: restricted },
  });
  expect(response.status).toBe(404);
  expect(response.status).not.toBe(403);
  expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ code: "NOT_FOUND" });
});
