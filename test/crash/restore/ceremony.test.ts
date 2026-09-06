import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ReadOnlyRecoveryError } from "@pi-hec/state-store";
import { loadUsageLedger, projectUsage } from "@pi-hec/usage";
import { performBackup, restoreReadOnly } from "../../../deploy/fa-ex1/backup/procedure.js";
import { completeRestoreCeremony } from "../../../deploy/fa-ex1/backup/restore.js";
import {
  artifact,
  bootstrapTrustedWorld,
  createTaskRun,
  digestOf,
  NOW,
  openTempStore,
  runIdFor,
} from "../../../packages/state-store/test/helpers.js";

test("restored store stays read-only until ceremony then projections match", async () => {
  const opened = openTempStore();
  const backupRoot = mkdtempSync(path.join(tmpdir(), "hec-restore-"));
  const recovery = generateKeyPairSync("x25519");
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-restore");
    const runId = runIdFor("2503");
    createTaskRun(opened.store, world, runId);
    const req = digestOf("cloud-req-restore");
    const ctx = digestOf("cloud-ctx-restore");
    const res = digestOf("cloud-res-restore");
    const verdict = digestOf("verdict-restore");
    opened.store.putArtifact(world.projectScope, artifact(req, "CanonicalCloudRequest", "creqR"));
    opened.store.putArtifact(world.projectScope, artifact(ctx, "ContextPacket", "cctxR"));
    opened.store.putArtifact(world.projectScope, artifact(res, "CloudCompletionReceipt", "cresR"));
    opened.store.putArtifact(world.projectScope, artifact(verdict, "VerdictReport", "verdR"));
    opened.store.createCloudCall(world.projectScope, {
      cloudCallId: "call-restore",
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
      cloudCallId: "call-restore",
      requestDigest: req,
      attemptId: "att-restore",
      requestStartedAt: NOW,
      updatedAt: NOW,
    });
    opened.store.completeCloudCall(world.projectScope, {
      cloudCallId: "call-restore",
      responseDigest: res,
      updatedAt: NOW,
    });
    opened.store.appendUsage(world.projectScope, {
      usageEntryId: "use-restore",
      cloudCallId: "call-restore",
      createdAt: NOW,
      inputTokens: 8,
      outputTokens: 3,
      normalizedTotalTokens: 11,
      providerReported: true,
      complete: true,
    });
    const sourceRun = opened.store.getRun(world.projectScope, runId);
    const sourceUsage = projectUsage({
      ...loadUsageLedger(opened.store, world.projectScope),
      scope: "run",
      runId,
    });

    const backup = await performBackup({
      store: opened.store,
      dbPath: opened.dbPath,
      casRoot: path.join(opened.dir, "cas"),
      reachableDigests: [verdict],
      appManifests: { schemaVersion: 1 },
      publicCerts: {},
      livePrivateKeyPaths: [],
      canaryCredential: "CANARY_UNUSED",
      backupRoot,
      recoveryPublicKey: recovery.publicKey,
    });

    const pending = restoreReadOnly({
      repositoryPath: backup.repositoryPath,
      destinationDir: path.join(backupRoot, "clean-host"),
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      masterKey: backup.resticMaster,
    });
    expect(pending.store.readOnlyRecovery).toBe(true);
    expect(() => {
      pending.store.vacuumInto(path.join(backupRoot, "nope.sqlite"));
    }).toThrow(ReadOnlyRecoveryError);
    pending.close();

    expect(() =>
      completeRestoreCeremony({
        destinationDir: path.join(backupRoot, "clean-host"),
        hostLeaseKey: opened.keys.hostLeaseKey,
        dbResponseKey: opened.keys.dbResponseKey,
      }),
    ).toThrow(/key material|irreversible/i);

    const pendingRestore = restoreReadOnly({
      repositoryPath: backup.repositoryPath,
      destinationDir: path.join(backupRoot, "clean-host"),
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      masterKey: backup.resticMaster,
    });
    pendingRestore.close();

    const tampered = path.join(backupRoot, "tampered");
    const pendingTamper = restoreReadOnly({
      repositoryPath: backup.repositoryPath,
      destinationDir: tampered,
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      masterKey: backup.resticMaster,
    });
    pendingTamper.close();
    const unitPath = path.join(tampered, "unit.json");
    const unit = JSON.parse(readFileSync(unitPath, "utf8")) as {
      reachable: { projectId: string; digest: string; bytesBase64: string }[];
    };
    unit.reachable.push({
      projectId: world.projectId,
      digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      bytesBase64: Buffer.from("tampered-bytes").toString("base64"),
    });
    writeFileSync(unitPath, JSON.stringify(unit));
    expect(() =>
      completeRestoreCeremony({
        destinationDir: tampered,
        hostLeaseKey: opened.keys.hostLeaseKey,
        dbResponseKey: opened.keys.dbResponseKey,
        recoveryPrivateKey: recovery.privateKey,
      }),
    ).toThrow(/digest/i);

    const openedWritable = completeRestoreCeremony({
      destinationDir: path.join(backupRoot, "clean-host"),
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      recoveryPrivateKey: recovery.privateKey,
    });
    try {
      expect(openedWritable.store.readOnlyRecovery).toBe(false);
      expect(openedWritable.restoreEpoch.length).toBeGreaterThan(8);
      expect(openedWritable.enrolledIdentities.broker.runnerId.length).toBeGreaterThan(0);
      expect(
        openedWritable.store.getRunner(openedWritable.enrolledIdentities.broker.runnerId),
      ).toBeDefined();
      expect(
        openedWritable.store.isRunnerCertificateRevoked(
          openedWritable.enrolledIdentities.broker.certificateSerial,
          openedWritable.enrolledIdentities.broker.spkiSha256,
        ),
      ).toBe(false);
      const run = openedWritable.store.getRun(world.projectScope, runId);
      expect(run.state).toBe(sourceRun.state);
      expect(run.stateVersion).toBe(sourceRun.stateVersion);
      const usage = projectUsage({
        ...loadUsageLedger(openedWritable.store, world.projectScope),
        scope: "run",
        runId,
      });
      expect(usage.acceptedCompletionCount).toBe(sourceUsage.acceptedCompletionCount);
      expect(usage.inputTokens).toBe(sourceUsage.inputTokens);
      expect(openedWritable.store.getArtifact(world.projectScope, verdict)?.digest).toBe(verdict);
    } finally {
      openedWritable.close();
    }
  } finally {
    opened.close();
  }
});
