import { expect, test } from "vitest";
import { objectDigestFromBytes } from "@pi-hec/contracts";
import { constructPrincipalScope } from "@pi-hec/security";
import { HOST_GRANT_POLICY, PROJECT_ID, RUN_ID, startHarness } from "./harness.js";
import { recordApplyReceipt } from "../src/services/promotion.js";
import { enqueueVerificationOperation } from "../src/services/verification-jobs.js";

test("promotion facade records a receipt and does not apply", async () => {
  const harness = await startHarness();
  try {
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
      authenticatedAt: harness.clock(),
    });
    const bytes = Buffer.from(
      JSON.stringify({ schemaName: "ApplyReceipt", outcome: "COMMITTED" }),
      "utf8",
    );
    const digest = await recordApplyReceipt(harness.listening.ctx, scope, PROJECT_ID, bytes);
    expect(digest.startsWith("sha256:")).toBe(true);
    expect(harness.store.hasArtifact(harness.store.toProjectScope(scope, PROJECT_ID), digest)).toBe(
      true,
    );
    expect(recordApplyReceipt.name).toBe("recordApplyReceipt");
  } finally {
    await harness.close();
  }
});

test("verification-jobs enqueues existing kinds and only notifies waitForWork", async () => {
  const harness = await startHarness();
  try {
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
      authenticatedAt: harness.clock(),
    });
    const projectScope = harness.store.toProjectScope(scope, PROJECT_ID);
    const inputDigest = objectDigestFromBytes(Buffer.from("verify-input", "utf8"));
    harness.store.putArtifact(projectScope, {
      digest: inputDigest,
      schemaName: null,
      mediaType: "application/json",
      byteSize: 12,
      classification: "internal",
      encryptionAlgorithm: "AES-256-GCM",
      encryptionKeyId: "cas:verify",
      encryptionNonce: "000000000000000000000001",
      storageRecordDigest: inputDigest,
      storageRecordSigningKeyId: "host-sign",
      storageRecordSignatureAlgorithm: "Ed25519",
      storageRecordSignedAt: harness.clock(),
      storageRecordSignerCertificateDigest: HOST_GRANT_POLICY,
      storageRecordSignature: "c2ln",
      createdAt: harness.clock(),
    });
    const waited = harness.listening.ctx.scheduler.waitForWork(1_000);
    const record = enqueueVerificationOperation(harness.listening.ctx, scope, {
      projectId: PROJECT_ID,
      runId: RUN_ID,
      operationKind: "MATERIALIZE_CANDIDATE",
      operationId: "op_01900000-0000-7000-8000-00000000abcd",
      inputDigest,
    });
    expect(record.operationKind).toBe("MATERIALIZE_CANDIDATE");
    expect(await waited).toBe(true);
    expect(harness.listening.ctx.scheduler.workers()).toEqual([]);
  } finally {
    await harness.close();
  }
});
