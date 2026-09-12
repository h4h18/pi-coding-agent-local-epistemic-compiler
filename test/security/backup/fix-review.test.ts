import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createFilesystemCas, MemoryStorageRecordSink, type KekHook } from "@pi-hec/cas";
import {
  CANARY_CREDENTIAL,
  performBackup,
  restoreReadOnly,
  unwrapDek,
} from "../../../faex1/deploy/backup/procedure.js";
import { runScheduledBackupJob } from "../../../faex1/deploy/backup/run-scheduled.js";
import {
  bootstrapTrustedWorld,
  openTempStore,
} from "../../../packages/state-store/test/helpers.js";

const DEK = Uint8Array.from({ length: 32 }, (_, index) => index + 7);

function kek(): KekHook {
  return { unwrapProjectDek: () => ({ keyId: "dek-fix", dek: DEK }) };
}

test("performBackup enumerates reachable CAS from casRoot and includes blob bytes", async () => {
  const opened = openTempStore();
  const casRoot = mkdtempSync(path.join(tmpdir(), "hec-cas-enum-"));
  const backupRoot = mkdtempSync(path.join(tmpdir(), "hec-bak-enum-"));
  const recovery = generateKeyPairSync("x25519");
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-enum");
    const cas = createFilesystemCas({
      rootDir: casRoot,
      sink: new MemoryStorageRecordSink(),
      kek: kek(),
    });
    const blob = Buffer.from("enumerated-cas-blob", "utf8");
    const put = await cas.putObject({
      projectId: world.projectId,
      bytes: blob,
      mediaType: "application/octet-stream",
      classification: "internal",
    });
    const result = await performBackup({
      store: opened.store,
      dbPath: opened.dbPath,
      casRoot,
      reachableDigests: [put.objectDigest],
      kek: kek(),
      appManifests: { schemaVersion: 1 },
      publicCerts: {},
      livePrivateKeyPaths: [],
      canaryCredential: CANARY_CREDENTIAL,
      backupRoot,
      recoveryPublicKey: recovery.publicKey,
    });
    const restored = restoreReadOnly({
      repositoryPath: result.repositoryPath,
      destinationDir: path.join(backupRoot, "restore"),
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      masterKey: result.resticMaster,
    });
    try {
      const restoredBytes = readFileSync(restored.casObjectPath(world.projectId, put.objectDigest));
      expect(Buffer.from(restoredBytes).equals(blob)).toBe(true);
    } finally {
      restored.close();
    }
  } finally {
    opened.close();
  }
});

test("dual-wrap unwraps the same project DEK with recovery key and fails without it", async () => {
  const opened = openTempStore();
  const casRoot = mkdtempSync(path.join(tmpdir(), "hec-cas-dek-"));
  const backupRoot = mkdtempSync(path.join(tmpdir(), "hec-bak-dek-"));
  const recovery = generateKeyPairSync("x25519");
  const stranger = generateKeyPairSync("x25519");
  try {
    bootstrapTrustedWorld(opened.store, "proj-dek");
    const result = await performBackup({
      store: opened.store,
      dbPath: opened.dbPath,
      casRoot,
      reachableDigests: [],
      kek: kek(),
      projectIds: ["proj-dek"],
      appManifests: { schemaVersion: 1 },
      publicCerts: {},
      livePrivateKeyPaths: [],
      canaryCredential: CANARY_CREDENTIAL,
      backupRoot,
      recoveryPublicKey: recovery.publicKey,
    });
    const wrap = result.dekWraps[0];
    expect(wrap?.projectId).toBe("proj-dek");
    expect(unwrapDek(wrap?.recovery ?? "", recovery.privateKey).equals(Buffer.from(DEK))).toBe(
      true,
    );
    expect(() => unwrapDek(wrap?.recovery ?? "", stranger.privateKey)).toThrow();
    expect(existsSync(path.join(result.repositoryPath, "master.key.json"))).toBe(false);
    expect(existsSync(path.join(path.dirname(result.repositoryPath), "master.key.json"))).toBe(
      false,
    );
  } finally {
    opened.close();
  }
});

test("hourly and on-terminal scheduled jobs invoke performBackup", async () => {
  const opened = openTempStore();
  const casRoot = mkdtempSync(path.join(tmpdir(), "hec-cas-sched-"));
  const backupRoot = mkdtempSync(path.join(tmpdir(), "hec-bak-sched-"));
  const secretDir = mkdtempSync(path.join(tmpdir(), "hec-sec-sched-"));
  mkdirSync(casRoot, { recursive: true });
  mkdirSync(path.join(secretDir, "deks"), { recursive: true });
  const recovery = generateKeyPairSync("x25519");
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-sched");
    writeFileSync(
      path.join(secretDir, "deks", `${world.projectId}.json`),
      JSON.stringify({ keyId: "dek-sched", dek: Buffer.from(DEK).toString("base64") }),
      "utf8",
    );
    const env = {
      PI_HEC_DB_PATH: opened.dbPath,
      PI_HEC_CAS_ROOT: casRoot,
      PI_HEC_BACKUP_ROOT: backupRoot,
      PI_HEC_HOST_SECRET_DIR: secretDir,
      PI_HEC_HOST_LEASE_KEY: Buffer.from(opened.keys.hostLeaseKey).toString("base64"),
      PI_HEC_DB_RESPONSE_KEY: Buffer.from(opened.keys.dbResponseKey).toString("base64"),
      PI_HEC_RECOVERY_PUBLIC_KEY: recovery.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
    };
    const hourly = await runScheduledBackupJob("hourly", env);
    expect(hourly).toMatch(/^epoch-/);
    expect(existsSync(path.join(backupRoot, "restic-repo", "config"))).toBe(true);
    const terminal = await runScheduledBackupJob("on-terminal", {
      ...env,
      PI_HEC_BACKUP_ROOT: path.join(backupRoot, "terminal"),
    });
    expect(terminal).toMatch(/^epoch-/);
    expect(existsSync(path.join(backupRoot, "terminal", "restic-repo", "config"))).toBe(true);
  } finally {
    opened.close();
  }
});

test("live private key bytes in the backup unit refuse the backup", async () => {
  const opened = openTempStore();
  const casRoot = mkdtempSync(path.join(tmpdir(), "hec-cas-live-"));
  const backupRoot = mkdtempSync(path.join(tmpdir(), "hec-bak-live-"));
  const recovery = generateKeyPairSync("x25519");
  try {
    bootstrapTrustedWorld(opened.store, "proj-live");
    const livePrivate = path.join(opened.dir, "fa.key");
    writeFileSync(livePrivate, "LIVE-FA-PRIVATE-MATERIAL-TASK25", "utf8");
    await expect(
      performBackup({
        store: opened.store,
        dbPath: opened.dbPath,
        casRoot,
        reachableDigests: [],
        appManifests: { leaked: "LIVE-FA-PRIVATE-MATERIAL-TASK25" },
        publicCerts: {},
        livePrivateKeyPaths: [livePrivate],
        canaryCredential: CANARY_CREDENTIAL,
        backupRoot,
        recoveryPublicKey: recovery.publicKey,
      }),
    ).rejects.toThrow(/private key|live|export/i);
  } finally {
    opened.close();
  }
});
