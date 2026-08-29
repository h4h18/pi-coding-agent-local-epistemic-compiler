import { expect, test } from "vitest";
import {
  artifact,
  bootstrapTrustedWorld,
  createTaskRun,
  digestOf,
  HOST_CAPABILITY,
  HOST_SIGNER,
  LATER,
  NOW,
  openTempStore,
  persistEnter,
  runIdFor,
  verified,
} from "./helpers.js";
import { openSqliteFile } from "../src/sqlite.js";

test("SUCCEEDED requires terminal_result_digest; other states require NULL", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-term");
    createTaskRun(opened.store, world, runIdFor("0300"));
    opened.store.close();
    const db = openSqliteFile(opened.dbPath);
    db.pragma("foreign_keys = ON");
    expect(() =>
      db
        .prepare("UPDATE runs SET state = 'SUCCEEDED' WHERE project_id = ? AND run_id = ?")
        .run(world.projectId, runIdFor("0300")),
    ).toThrow(/CHECK|constraint/i);
    db.close();
  } finally {
    opened.close();
  }
});

test("run_events and usage_entries are append-only; correction uniqueness and no self-ref", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-append");
    const { projection, taskDigest } = createTaskRun(opened.store, world, runIdFor("0301"));
    persistEnter(
      opened.store,
      world.projectScope,
      projection,
      "SNAPSHOT_REQUESTED",
      verified([{ role: "task-envelope", objectDigest: taskDigest }]),
      "evt-append",
    );
    const req = digestOf("cloud-req");
    const ctx = digestOf("cloud-ctx");
    opened.store.putArtifact(world.projectScope, artifact(req, "CanonicalCloudRequest", "creq"));
    opened.store.putArtifact(world.projectScope, artifact(ctx, "ContextPacket", "cctx"));
    opened.store.createCloudCall(world.projectScope, {
      cloudCallId: "call-1",
      runId: runIdFor("0301"),
      purpose: "initial",
      deploymentId: "dep-1",
      requestDigest: req,
      contextPacketDigest: ctx,
      recoveryGrade: "A",
      state: "prepared",
      createdAt: NOW,
    });
    opened.store.appendUsage(world.projectScope, {
      usageEntryId: "usage-1",
      cloudCallId: "call-1",
      createdAt: NOW,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      normalizedTotalTokens: 2,
      providerReported: true,
      complete: true,
    });
    opened.store.appendUsage(world.projectScope, {
      usageEntryId: "usage-2",
      cloudCallId: "call-1",
      createdAt: NOW,
      correctionOf: "usage-1",
      inputTokens: 2,
      outputTokens: 1,
      reasoningTokens: 0,
      normalizedTotalTokens: 3,
      providerReported: true,
      complete: true,
    });
    opened.store.close();
    const db = openSqliteFile(opened.dbPath);
    db.pragma("foreign_keys = ON");
    expect(() =>
      db.prepare("UPDATE run_events SET actor_id = 'x' WHERE project_id = ?").run(world.projectId),
    ).toThrow(/append-only/i);
    expect(() =>
      db.prepare("DELETE FROM run_events WHERE project_id = ?").run(world.projectId),
    ).toThrow(/append-only/i);
    expect(() =>
      db.prepare("UPDATE usage_entries SET complete = 0 WHERE project_id = ?").run(world.projectId),
    ).toThrow(/append-only/i);
    expect(() =>
      db.prepare("DELETE FROM usage_entries WHERE project_id = ?").run(world.projectId),
    ).toThrow(/append-only/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO usage_entries(
            project_id, usage_entry_id, cloud_call_id, provider_reported, complete, created_at, correction_of,
            input_tokens, output_tokens, reasoning_tokens, normalized_total_tokens
          ) VALUES (?, 'usage-3', 'call-1', 1, 1, ?, 'usage-1', 1, 1, 0, 2)`,
        )
        .run(world.projectId, NOW),
    ).toThrow(/UNIQUE|constraint/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO usage_entries(
            project_id, usage_entry_id, cloud_call_id, provider_reported, complete, created_at, correction_of
          ) VALUES (?, 'usage-self', 'call-1', 1, 0, ?, 'usage-self')`,
        )
        .run(world.projectId, NOW),
    ).toThrow(/CHECK|constraint/i);
    db.close();
  } finally {
    opened.close();
  }
});

test("artifact role triggers reject unknown roles, schema mismatch, and singular duplicates", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-roles");
    const { taskDigest } = createTaskRun(opened.store, world, runIdFor("0302"));
    opened.store.close();
    const db = openSqliteFile(opened.dbPath);
    db.pragma("foreign_keys = ON");
    expect(() =>
      db
        .prepare(
          `INSERT INTO run_artifacts(project_id, run_id, role, artifact_digest, created_at)
           VALUES (?, ?, 'not-a-role', ?, ?)`,
        )
        .run(world.projectId, runIdFor("0302"), taskDigest, NOW),
    ).toThrow(/unknown or schema-mismatched/i);
    const wrong = digestOf("wrong-schema");
    db.prepare(
      `INSERT INTO artifacts(
        project_id, digest, schema_name, media_type, byte_size, classification, encryption_algorithm,
        encryption_key_id, encryption_nonce, storage_record_digest, storage_record_signing_key_id,
        storage_record_signature_algorithm, storage_record_signed_at, storage_record_signer_certificate_digest,
        storage_record_signature, created_at
      ) VALUES (?, ?, 'WrongSchema', 'application/json', 1, 'internal', 'AES-256-GCM', ?, ?, ?, 'k', 'Ed25519', ?, ?, 'c2ln', ?)`,
    ).run(
      world.projectId,
      wrong,
      "key-wrong",
      "nonce-wrong-000000000001",
      digestOf("sr-wrong"),
      NOW,
      HOST_SIGNER,
      NOW,
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO run_artifacts(project_id, run_id, role, artifact_digest, created_at)
           VALUES (?, ?, 'task-envelope', ?, ?)`,
        )
        .run(world.projectId, runIdFor("0302"), wrong, NOW),
    ).toThrow(/unknown or schema-mismatched|singular/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO run_artifacts(project_id, run_id, role, artifact_digest, created_at)
           VALUES (?, ?, 'task-envelope', ?, ?)`,
        )
        .run(world.projectId, runIdFor("0302"), taskDigest, NOW),
    ).toThrow(/singular/i);
    db.close();
  } finally {
    opened.close();
  }
});

test("insertRunnerCertificate revokes previous unrevoked leaves for the same runner", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-rotate-cert");
    opened.store.createRunner(world.scope, {
      runnerId: "runner-rotate",
      principalId: "runner-rotate-principal",
      platform: "windows",
      capabilityDigest: HOST_CAPABILITY,
      lastSeenAt: NOW,
    });
    opened.store.insertRunnerCertificate(world.scope, {
      certificateSerial: "aa",
      runnerId: "runner-rotate",
      spkiSha256: "a".repeat(64),
      notBefore: NOW,
      notAfter: LATER,
      issuedAt: NOW,
    });
    opened.store.insertRunnerCertificate(world.scope, {
      certificateSerial: "bb",
      runnerId: "runner-rotate",
      spkiSha256: "b".repeat(64),
      notBefore: NOW,
      notAfter: LATER,
      issuedAt: LATER,
    });
    expect(opened.store.isRunnerCertificateRevoked("aa", "a".repeat(64))).toBe(true);
    expect(opened.store.isRunnerCertificateRevoked("bb", "b".repeat(64))).toBe(false);
    expect(opened.store.lookupRunnerCertificateBySerial("aa")?.revokedAt).toBe(LATER);
  } finally {
    opened.close();
  }
});
