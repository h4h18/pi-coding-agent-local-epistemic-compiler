import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createFilesystemCas, MemoryStorageRecordSink } from "@pi-hec/cas";
import { sha256Utf8, type ObjectDigest } from "@pi-hec/contracts";
import { ReadOnlyRecoveryError } from "@pi-hec/state-store";
import { projectUsage } from "@pi-hec/usage";
import {
  CANARY_CREDENTIAL,
  performBackup,
  restoreReadOnly,
} from "../../../deploy/fa-ex1/backup/procedure.js";
import {
  artifact,
  bootstrapTrustedWorld,
  createTaskRun,
  digestOf,
  NOW,
  openTempStore,
  runIdFor,
} from "../../../packages/state-store/test/helpers.js";

const DEK = Uint8Array.from({ length: 32 }, (_, index) => index + 3);

function walkFiles(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    const info = statSync(current);
    if (info.isDirectory()) {
      for (const entry of readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    found.push(current);
  }
  return found;
}

test("backup epoch to restic AEAD second copy restores bytes and excludes canary", async () => {
  const opened = openTempStore();
  const casRoot = mkdtempSync(path.join(tmpdir(), "hec-cas-"));
  const backupRoot = mkdtempSync(path.join(tmpdir(), "hec-bak-"));
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-backup-iso");
    const runId = runIdFor("2501");
    createTaskRun(opened.store, world, runId);
    const req = digestOf("cloud-req-25");
    const ctx = digestOf("cloud-ctx-25");
    const res = digestOf("cloud-res-25");
    opened.store.putArtifact(world.projectScope, artifact(req, "CanonicalCloudRequest", "creq25"));
    opened.store.putArtifact(world.projectScope, artifact(ctx, "ContextPacket", "cctx25"));
    opened.store.putArtifact(world.projectScope, artifact(res, "CloudCompletionReceipt", "cres25"));
    opened.store.createCloudCall(world.projectScope, {
      cloudCallId: "call-25-iso",
      runId,
      purpose: "initial",
      deploymentId: "dep-1",
      requestDigest: req,
      contextPacketDigest: ctx,
      recoveryGrade: "C",
      state: "prepared",
      createdAt: NOW,
    });
    opened.store.transitionPreparedCloudCallToDispatching(world.projectScope, {
      cloudCallId: "call-25-iso",
      requestDigest: req,
      attemptId: "att-25-iso",
      requestStartedAt: NOW,
      updatedAt: NOW,
    });
    opened.store.completeCloudCall(world.projectScope, {
      cloudCallId: "call-25-iso",
      responseDigest: res,
      updatedAt: NOW,
    });
    opened.store.appendUsage(world.projectScope, {
      usageEntryId: "use-25-iso",
      cloudCallId: "call-25-iso",
      createdAt: NOW,
      inputTokens: 10,
      outputTokens: 4,
      normalizedTotalTokens: 14,
      providerReported: true,
      complete: true,
    });

    const sink = new MemoryStorageRecordSink();
    const cas = createFilesystemCas({
      rootDir: casRoot,
      sink,
      kek: { unwrapProjectDek: () => ({ keyId: "dek-iso", dek: DEK }) },
    });
    const blob = Buffer.from("reachable-cas-blob", "utf8");
    const put = await cas.putObject({
      projectId: world.projectId,
      bytes: blob,
      mediaType: "application/octet-stream",
      classification: "internal",
    });

    const livePrivate = path.join(opened.dir, "live-fa.key");
    writeFileSync(livePrivate, CANARY_CREDENTIAL, "utf8");

    const result = await performBackup({
      store: opened.store,
      dbPath: opened.dbPath,
      casRoot,
      reachableDigests: [put.objectDigest],
      kek: { unwrapProjectDek: () => ({ keyId: "dek-iso", dek: DEK }) },
      appManifests: { schemaVersion: 1, models: ["qwen3.6-27b"] },
      publicCerts: { fa: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" },
      livePrivateKeyPaths: [livePrivate],
      canaryCredential: CANARY_CREDENTIAL,
      backupRoot,
      recoveryPublicKey: resultKey().publicKey,
    });

    expect(result.epoch.length).toBeGreaterThan(8);
    expect(result.quickCheck).toBe("ok");
    expect(result.secondCopyPath.length).toBeGreaterThan(0);
    expect(result.resticVersion).toBe("0.19.1");

    const payload = walkFiles(result.repositoryPath)
      .concat(walkFiles(result.secondCopyPath))
      .map((filePath) => readFileSync(filePath));
    for (const bytes of payload) {
      expect(bytes.includes(Buffer.from(CANARY_CREDENTIAL, "utf8"))).toBe(false);
    }

    const restored = restoreReadOnly({
      repositoryPath: result.repositoryPath,
      destinationDir: path.join(backupRoot, "restore-host"),
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      masterKey: result.resticMaster,
    });
    try {
      expect(restored.store.readOnlyRecovery).toBe(true);
      expect(restored.store.getRun(world.projectScope, runId).state).toBe("CREATED");
      const restoredBytes = readFileSync(restored.casObjectPath(world.projectId, put.objectDigest));
      expect(createHash("sha256").update(restoredBytes).digest("hex")).toBe(
        put.objectDigest.slice("sha256:".length),
      );
      expect(() => {
        restored.store.appendUsage(world.projectScope, {
          usageEntryId: "use-forbidden",
          cloudCallId: "call-25-iso",
          createdAt: NOW,
          providerReported: true,
          complete: true,
        });
      }).toThrow(ReadOnlyRecoveryError);
    } finally {
      restored.close();
    }
  } finally {
    opened.close();
  }
});

test("backup isolation never emits 403 and is an indistinguishable 404", async () => {
  const opened = openTempStore();
  const backupRoot = mkdtempSync(path.join(tmpdir(), "hec-bak-iso-"));
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-a-iso");
    const other = bootstrapTrustedWorld(opened.store, "proj-b-iso");
    const result = await performBackup({
      store: opened.store,
      dbPath: opened.dbPath,
      casRoot: path.join(opened.dir, "cas-empty"),
      reachableDigests: [],
      appManifests: { schemaVersion: 1 },
      publicCerts: {},
      livePrivateKeyPaths: [],
      canaryCredential: CANARY_CREDENTIAL,
      backupRoot,
      recoveryPublicKey: resultKey().publicKey,
      kek: { unwrapProjectDek: () => ({ keyId: "dek-iso", dek: DEK }) },
    });
    const missing = sha256Utf8("no-such-backup-object") as ObjectDigest;
    const a = result.lookup({ projectId: world.projectId, objectDigest: missing });
    const b = result.lookup({ projectId: other.projectId, objectDigest: missing });
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(a.status).not.toBe(403);
    expect(b.status).not.toBe(403);
    expect(a.body).toEqual(b.body);
    expect(JSON.stringify(a.body)).not.toMatch(/exist|forbidden|403/i);
  } finally {
    opened.close();
  }
});

test("usage projection after backup source is informational and does not limit", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-usage-limit");
    const runId = runIdFor("2502");
    createTaskRun(opened.store, world, runId);
    const req = digestOf("cloud-req-limit");
    const ctx = digestOf("cloud-ctx-limit");
    const res = digestOf("cloud-res-limit");
    opened.store.putArtifact(world.projectScope, artifact(req, "CanonicalCloudRequest", "creqL"));
    opened.store.putArtifact(world.projectScope, artifact(ctx, "ContextPacket", "cctxL"));
    opened.store.putArtifact(world.projectScope, artifact(res, "CloudCompletionReceipt", "cresL"));
    opened.store.createCloudCall(world.projectScope, {
      cloudCallId: "call-limit",
      runId,
      purpose: "initial",
      deploymentId: "dep-1",
      requestDigest: req,
      contextPacketDigest: ctx,
      recoveryGrade: "C",
      state: "prepared",
      createdAt: NOW,
    });
    opened.store.transitionPreparedCloudCallToDispatching(world.projectScope, {
      cloudCallId: "call-limit",
      requestDigest: req,
      attemptId: "att-limit",
      requestStartedAt: NOW,
      updatedAt: NOW,
    });
    opened.store.completeCloudCall(world.projectScope, {
      cloudCallId: "call-limit",
      responseDigest: res,
      updatedAt: NOW,
    });
    opened.store.appendUsage(world.projectScope, {
      usageEntryId: "use-limit",
      cloudCallId: "call-limit",
      createdAt: NOW,
      inputTokens: 1,
      outputTokens: 1,
      normalizedTotalTokens: 2,
      providerReported: true,
      complete: true,
    });
    const projection = projectUsage({
      entries: opened.store.listUsageEntries(world.projectScope).map((record) => ({
        usageEntryId: record.usageEntryId,
        cloudCallId: record.cloudCallId,
        runId: record.runId,
        workspaceId: record.workspaceId,
        projectId: world.projectId,
        createdAt: record.createdAt,
        correctionOf: record.correctionOf,
        inputTokens: record.inputTokens ?? null,
        outputTokens: record.outputTokens ?? null,
        reasoningTokens: record.reasoningTokens ?? null,
        cachedInputTokens: record.cachedInputTokens ?? null,
        cacheWriteTokens: record.cacheWriteTokens ?? null,
        normalizedTotalTokens: record.normalizedTotalTokens ?? null,
        providerReported: record.providerReported,
        complete: record.complete,
        currency: record.currency ?? null,
        estimatedCostDecimal: record.estimatedCostDecimal ?? null,
        pricingSnapshotDigest: record.pricingSnapshotDigest ?? null,
      })),
      calls: opened.store.listCloudCallOutcomes(world.projectScope),
      scope: "run",
      runId,
    });
    expect(projection.acceptedCompletionCount).toBe(1);
    expect(projection.estimatedCostDecimal).not.toBe("blocked");
  } finally {
    opened.close();
  }
});

function resultKey() {
  return generateKeyPairSync("x25519");
}
