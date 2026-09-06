import { expect, test } from "vitest";
import {
  ARGON2ID_TEST_PARAMETERS,
  defaultControlMigrationsDir,
  openStateStore,
  ReadOnlyRecoveryError,
} from "../src/index.js";
import { bootstrapTrustedWorld, createTaskRun, digestOf, openTempStore, runIdFor } from "./helpers.js";
import { openSqliteFile } from "../src/sqlite.js";

test("registry seeds match contract helpers", () => {
  const opened = openTempStore();
  try {
    expect(opened.store.isReadOnlyRecovery()).toBe(false);
    const world = bootstrapTrustedWorld(opened.store, "proj-reg");
    createTaskRun(opened.store, world, runIdFor("0010"));
    expect(opened.store.getRun(world.projectScope, runIdFor("0010")).state).toBe("CREATED");
  } finally {
    opened.close();
  }
});

test("extra registry state forces read-only recovery", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-extra");
    createTaskRun(opened.store, world, runIdFor("0011"));
    opened.store.close();
    const raw = openSqliteFile(opened.dbPath);
    raw.prepare("INSERT INTO run_state_registry(state) VALUES ('NOT_A_REAL_STATE')").run();
    raw.close();
    const recovered = openStateStore({
      dbPath: opened.dbPath,
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      migrationsDir: defaultControlMigrationsDir(),
      argon2: ARGON2ID_TEST_PARAMETERS,
    });
    try {
      expect(recovered.isReadOnlyRecovery()).toBe(true);
      expect(recovered.getRun(world.projectScope, runIdFor("0011")).state).toBe("CREATED");
      expect(() =>
        recovered.createRun(world.projectScope, {
          runId: runIdFor("0012"),
          workspaceId: world.workspaceId,
          taskEnvelopeDigest: digestOf(`task:${world.projectId}:${runIdFor("0012")}`),
          createdAt: "2026-08-28T00:00:00.000Z",
        }),
      ).toThrow(ReadOnlyRecoveryError);
    } finally {
      recovered.close();
    }
  } finally {
    opened.close();
  }
});

test("missing registry state forces read-only recovery", () => {
  const opened = openTempStore();
  try {
    opened.store.close();
    const raw = openSqliteFile(opened.dbPath);
    raw.prepare("DELETE FROM run_state_registry WHERE state = 'CREATED'").run();
    raw.close();
    const recovered = openStateStore({
      dbPath: opened.dbPath,
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      migrationsDir: defaultControlMigrationsDir(),
      argon2: ARGON2ID_TEST_PARAMETERS,
    });
    try {
      expect(recovered.isReadOnlyRecovery()).toBe(true);
    expect(() => {
      recovered.putHostAuthorityArtifact({
        objectDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        schemaName: "HostAuthority",
        mediaType: "application/json",
        byteSize: 1,
        encryptionKeyId: "k",
        encryptionNonce: "n",
        signatureKeyId: "s",
        signature: "x",
        createdAt: "2026-08-28T00:00:00.000Z",
      });
    }).toThrow(ReadOnlyRecoveryError);
    } finally {
      recovered.close();
    }
  } finally {
    opened.close();
  }
});
