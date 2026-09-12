import { afterAll, beforeAll, expect, test } from "vitest";
import { recoverOperations } from "../src/orchestration/recovery.js";
import {
  HOST_POLICY,
  PROJECT_ID,
  RUN_ID,
  digestOf,
  opId,
  startHarness,
  type Harness,
} from "./harness.js";
import { constructPrincipalScope } from "@pi-hec/security";

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
  }
});

test("startup recovery does not duplicate succeeded operations", () => {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  const now = harness.clock();
  const admin = harness.listening.ctx.hostAdminRecord;
  const scope = constructPrincipalScope({
    record: admin,
    grants: [
      {
        projectId: PROJECT_ID,
        roles: ["admin"],
        grantObjectDigest: HOST_POLICY,
        revokedAt: undefined,
      },
    ],
    authenticatedAt: now,
  });
  const projectScope = harness.store.toProjectScope(scope, PROJECT_ID);
  const inputDigest = digestOf("recovery-input");
  const resultDigest = digestOf("recovery-result");
  const errorDigest = digestOf("recovery-error");
  harness.store.putArtifact(projectScope, {
    digest: inputDigest,
    schemaName: null,
    mediaType: "application/json",
    byteSize: 8,
    classification: "internal",
    encryptionAlgorithm: "AES-256-GCM",
    encryptionKeyId: "cas:recovery",
    encryptionNonce: "000000000000000000000001",
    storageRecordDigest: digestOf("storage-recovery"),
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: now,
    storageRecordSignerCertificateDigest: digestOf("host-signer-cert"),
    storageRecordSignature: "c2ln",
    createdAt: now,
  });
  harness.store.putArtifact(projectScope, {
    digest: resultDigest,
    schemaName: null,
    mediaType: "application/json",
    byteSize: 8,
    classification: "internal",
    encryptionAlgorithm: "AES-256-GCM",
    encryptionKeyId: "cas:recovery-result",
    encryptionNonce: "000000000000000000000002",
    storageRecordDigest: digestOf("storage-recovery-result"),
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: now,
    storageRecordSignerCertificateDigest: digestOf("host-signer-cert"),
    storageRecordSignature: "c2ln",
    createdAt: now,
  });
  harness.store.putArtifact(projectScope, {
    digest: errorDigest,
    schemaName: null,
    mediaType: "application/json",
    byteSize: 8,
    classification: "internal",
    encryptionAlgorithm: "AES-256-GCM",
    encryptionKeyId: "cas:recovery-error",
    encryptionNonce: "000000000000000000000003",
    storageRecordDigest: digestOf("storage-recovery-error"),
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: now,
    storageRecordSignerCertificateDigest: digestOf("host-signer-cert"),
    storageRecordSignature: "c2ln",
    createdAt: now,
  });
  const succeededId = opId(0xaaa);
  harness.store.enqueueOperation(projectScope, {
    operationId: succeededId,
    runId: RUN_ID,
    operationKind: "CAPTURE_SNAPSHOT",
    dedupeKey: `recovery-succeeded:${succeededId}`,
    inputDigest,
    createdAt: now,
  });
  const leased = harness.store.leaseOperation(projectScope, {
    operationId: succeededId,
    owner: "runner-principal",
    leaseUntil: new Date(Date.parse(now) + 30_000).toISOString(),
    now,
  });
  harness.store.completeOperation(projectScope, {
    operationId: succeededId,
    token: leased.token,
    owner: "runner-principal",
    resultDigest,
    now,
    updatedAt: now,
  });
  const first = recoverOperations({
    store: harness.store,
    adminScope: scope,
    now,
    errorDigest,
  });
  const second = recoverOperations({
    store: harness.store,
    adminScope: scope,
    now,
    errorDigest,
  });
  expect(first.succeededSkipped).toBeGreaterThanOrEqual(1);
  expect(second.succeededSkipped).toBe(first.succeededSkipped);
  const row = harness.store.getOperation(projectScope, succeededId);
  expect(row.state).toBe("succeeded");
});
