import { createPublicKey } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ARGON2ID_TEST_PARAMETERS, defaultControlMigrationsDir, openStateStore } from "@pi-hec/state-store";
import { collectBackupProjectIds, createHostKekHook } from "./host-secrets.js";
import { BACKUP_SCHEDULE, type BackupScheduleKind } from "./schedule.js";
import { listCasProjectIds, performBackup, restoreReadOnly, sqliteIntegrityCheck, sqliteQuickCheck } from "./procedure.js";
import { verifyResticRepo } from "./restic-aead.js";

export function parseScheduleKind(value: string): BackupScheduleKind {
  const known = new Set<string>(Object.values(BACKUP_SCHEDULE));
  if (!known.has(value)) {
    throw new Error(`unknown backup schedule ${value}`);
  }
  return value as BackupScheduleKind;
}

export async function runScheduledBackupJob(
  kind: BackupScheduleKind,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  switch (kind) {
    case "on-terminal":
    case "hourly":
      return executePerformBackup(env);
    case "daily-integrity": {
      const dbPath = required(env, "PI_HEC_DB_PATH");
      const check = sqliteIntegrityCheck(dbPath);
      if (check !== "ok") {
        throw new Error(`integrity_check failed: ${check}`);
      }
      return sqliteQuickCheck(dbPath);
    }
    case "weekly-cas-scrub":
      return `cas-entries:${String(walkFiles(required(env, "PI_HEC_CAS_ROOT")).length)}`;
    case "monthly-full-read": {
      const repo = required(env, "PI_HEC_RESTIC_REPO");
      verifyResticRepo(repo, {
        encrypt: Buffer.from(required(env, "PI_HEC_RESTIC_ENCRYPT"), "base64"),
        macK: Buffer.from(required(env, "PI_HEC_RESTIC_MACK"), "base64"),
        macR: Buffer.from(required(env, "PI_HEC_RESTIC_MACR"), "base64"),
      });
      return "restic-full-read-ok";
    }
    case "quarterly-restore-drill": {
      const restored = restoreReadOnly({
        repositoryPath: required(env, "PI_HEC_RESTIC_REPO"),
        destinationDir: required(env, "PI_HEC_RESTORE_DRILL_DIR"),
        hostLeaseKey: Buffer.from(required(env, "PI_HEC_HOST_LEASE_KEY"), "base64"),
        dbResponseKey: Buffer.from(required(env, "PI_HEC_DB_RESPONSE_KEY"), "base64"),
        masterKey: {
          encrypt: Buffer.from(required(env, "PI_HEC_RESTIC_ENCRYPT"), "base64"),
          macK: Buffer.from(required(env, "PI_HEC_RESTIC_MACK"), "base64"),
          macR: Buffer.from(required(env, "PI_HEC_RESTIC_MACR"), "base64"),
        },
      });
      restored.close();
      return "restore-drill-read-only";
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled schedule ${String(exhaustive)}`);
    }
  }
}

async function executePerformBackup(env: NodeJS.ProcessEnv): Promise<string> {
  const store = openStateStore({
    dbPath: required(env, "PI_HEC_DB_PATH"),
    hostLeaseKey: Buffer.from(required(env, "PI_HEC_HOST_LEASE_KEY"), "base64"),
    dbResponseKey: Buffer.from(required(env, "PI_HEC_DB_RESPONSE_KEY"), "base64"),
    migrationsDir: defaultControlMigrationsDir(),
    argon2: ARGON2ID_TEST_PARAMETERS,
  });
  try {
    const secretDir = required(env, "PI_HEC_HOST_SECRET_DIR");
    const casRoot = required(env, "PI_HEC_CAS_ROOT");
    const kek = createHostKekHook(secretDir);
    const result = await performBackup({
      store,
      dbPath: required(env, "PI_HEC_DB_PATH"),
      casRoot,
      reachableDigests: [],
      kek,
      projectIds: collectBackupProjectIds({
        store,
        secretDir,
        casProjectIds: listCasProjectIds(casRoot),
      }),
      hostSecretDir: secretDir,
      appManifests: { schemaVersion: 1 },
      publicCerts: {},
      livePrivateKeyPaths: [],
      canaryCredential: env.PI_HEC_CANARY ?? "CANARY_UNUSED",
      backupRoot: required(env, "PI_HEC_BACKUP_ROOT"),
      recoveryPublicKey: createPublicKey({
        key: Buffer.from(required(env, "PI_HEC_RECOVERY_PUBLIC_KEY"), "base64"),
        format: "der",
        type: "spki",
      }),
    });
    return result.epoch;
  } finally {
    store.close();
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

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
    void readFileSync(current);
  }
  return found;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const kind = parseScheduleKind(process.argv[2] ?? "");
  void runScheduledBackupJob(kind).then((line) => {
    process.stdout.write(`${line}\n`);
  });
}
