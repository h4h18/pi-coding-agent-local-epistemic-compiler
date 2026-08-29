import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  checksumSqlBytes,
  INITIAL_MIGRATION_NAME,
  INITIAL_MIGRATION_VERSION,
  defaultControlMigrationsDir,
  migrationFilePath,
  openStateStore,
  ARGON2ID_TEST_PARAMETERS,
} from "../src/index.js";
import { bootstrapTrustedWorld, openTempStore, reopenStore, runIdFor, createTaskRun } from "./helpers.js";

test("applies migration checksum and restores pragmas from backup", async () => {
  const opened = openTempStore();
  try {
    const sqlPath = migrationFilePath(defaultControlMigrationsDir());
    const bytes = readFileSync(sqlPath);
    const expected = checksumSqlBytes(bytes);
    const row = opened.store.schemaMigration();
    expect(row.version).toBe(INITIAL_MIGRATION_VERSION);
    expect(row.name).toBe(INITIAL_MIGRATION_NAME);
    expect(row.checksum).toBe(expected);
    expect(opened.store.readPragmas()).toEqual({
      journal_mode: "wal",
      synchronous: "FULL",
      foreign_keys: "ON",
      trusted_schema: "OFF",
      busy_timeout: 5000,
      locking_mode: "NORMAL",
    });

    const world = bootstrapTrustedWorld(opened.store, "proj-backup");
    createTaskRun(opened.store, world, runIdFor("0001"));

    const backupPath = path.join(opened.dir, "backup.sqlite");
    await opened.store.backup(backupPath);
    opened.store.close();

    const restored = openStateStore({
      dbPath: backupPath,
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      migrationsDir: defaultControlMigrationsDir(),
      argon2: ARGON2ID_TEST_PARAMETERS,
    });
    try {
      expect(restored.readPragmas()).toEqual({
        journal_mode: "wal",
        synchronous: "FULL",
        foreign_keys: "ON",
        trusted_schema: "OFF",
        busy_timeout: 5000,
        locking_mode: "NORMAL",
      });
      expect(restored.schemaMigration().checksum).toBe(expected);
      expect(restored.getRun(world.projectScope, runIdFor("0001")).state).toBe("CREATED");
    } finally {
      restored.close();
    }
  } finally {
    opened.close();
  }
});

test("VACUUM INTO restore continues with the same pragmas", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-vacuum");
    createTaskRun(opened.store, world, runIdFor("0002"));
    const dest = path.join(opened.dir, "vacuum.sqlite");
    opened.store.vacuumInto(dest);
    opened.store.close();
    const restored = openStateStore({
      dbPath: dest,
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      migrationsDir: defaultControlMigrationsDir(),
      argon2: ARGON2ID_TEST_PARAMETERS,
    });
    try {
      expect(restored.readPragmas().journal_mode).toBe("wal");
      expect(restored.getRun(world.projectScope, runIdFor("0002")).stateVersion).toBe(0);
    } finally {
      restored.close();
    }
  } finally {
    opened.close();
  }
});

test("reopen after backup keeps WAL FULL foreign_keys trusted_schema timeout", () => {
  const opened = openTempStore();
  try {
    opened.store.close();
    const again = reopenStore(opened);
    try {
      expect(again.readPragmas()).toMatchObject({
        journal_mode: "wal",
        synchronous: "FULL",
        foreign_keys: "ON",
        trusted_schema: "OFF",
        busy_timeout: 5000,
        locking_mode: "NORMAL",
      });
    } finally {
      again.close();
    }
  } finally {
    opened.close();
  }
});
