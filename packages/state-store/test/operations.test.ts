import { expect, test } from "vitest";
import { ConflictError, LeaseError } from "../src/index.js";
import {
  artifact,
  bootstrapTrustedWorld,
  createTaskRun,
  digestOf,
  HOST_POLICY,
  LATER,
  NOW,
  openTempStore,
  opIdFor,
  randomSecret,
  reopenStore,
  runIdFor,
} from "./helpers.js";

test("operation dedupe, lease generation, token verify, and expired generation cannot complete", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-ops");
    const { taskDigest } = createTaskRun(opened.store, world, runIdFor("0200"));
    const inputDigest = digestOf("op-input");
    const resultDigest = digestOf("op-result");
    opened.store.putArtifact(world.projectScope, artifact(inputDigest, null, "op-input"));
    opened.store.putArtifact(world.projectScope, artifact(resultDigest, null, "op-result"));
    const first = opened.store.enqueueOperation(world.projectScope, {
      operationId: opIdFor("0200"),
      runId: runIdFor("0200"),
      operationKind: "CAPTURE_SNAPSHOT",
      dedupeKey: "capture",
      inputDigest,
      createdAt: NOW,
    });
    expect(first.state).toBe("ready");
    const again = opened.store.enqueueOperation(world.projectScope, {
      operationId: opIdFor("0200"),
      runId: runIdFor("0200"),
      operationKind: "CAPTURE_SNAPSHOT",
      dedupeKey: "capture",
      inputDigest,
      createdAt: NOW,
    });
    expect(again.state).toBe("ready");
    expect(() =>
      opened.store.enqueueOperation(world.projectScope, {
        operationId: opIdFor("0200"),
        runId: runIdFor("0200"),
        operationKind: "CAPTURE_SNAPSHOT",
        dedupeKey: "capture",
        inputDigest: taskDigest,
        createdAt: NOW,
      }),
    ).toThrow(ConflictError);

    const lease1 = opened.store.leaseOperation(world.projectScope, {
      operationId: opIdFor("0200"),
      owner: "worker-1",
      leaseUntil: NOW,
      now: NOW,
    });
    expect(lease1.generation).toBe(1);
    const lease2 = opened.store.leaseOperation(world.projectScope, {
      operationId: opIdFor("0200"),
      owner: "worker-2",
      leaseUntil: LATER,
      now: LATER,
    });
    expect(lease2.generation).toBe(2);
    expect(() =>
      opened.store.completeOperation(world.projectScope, {
        operationId: opIdFor("0200"),
        token: lease1.token,
        owner: "worker-1",
        resultDigest,
        now: LATER,
        updatedAt: LATER,
      }),
    ).toThrow(LeaseError);
    const done = opened.store.completeOperation(world.projectScope, {
      operationId: opIdFor("0200"),
      token: lease2.token,
      owner: "worker-2",
      resultDigest,
      now: LATER,
      updatedAt: LATER,
    });
    expect(done.state).toBe("succeeded");
    expect(done.resultDigest).toBe(resultDigest);

    opened.store.close();
    const reopened = reopenStore(opened);
    try {
      const restarted = reopened.enqueueOperation(world.projectScope, {
        operationId: opIdFor("0200"),
        runId: runIdFor("0200"),
        operationKind: "CAPTURE_SNAPSHOT",
        dedupeKey: "capture",
        inputDigest,
        createdAt: LATER,
      });
      expect(restarted.state).toBe("succeeded");
      expect(restarted.resultDigest).toBe(resultDigest);
    } finally {
      reopened.close();
    }
  } finally {
    opened.close();
  }
});

test("non-reclaimable kinds cannot be leased after leaving ready", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-noreclaim");
    createTaskRun(opened.store, world, runIdFor("0201"));
    const inputDigest = digestOf("cancel-op-input");
    const resultDigest = digestOf("cancel-op-result");
    opened.store.putArtifact(world.projectScope, artifact(inputDigest, null, "cancel-in"));
    opened.store.putArtifact(world.projectScope, artifact(resultDigest, null, "cancel-out"));
    opened.store.enqueueOperation(world.projectScope, {
      operationId: opIdFor("0201"),
      runId: runIdFor("0201"),
      operationKind: "REQUEST_CANCELLATION",
      dedupeKey: "cancel",
      inputDigest,
      createdAt: NOW,
    });
    const lease = opened.store.leaseOperation(world.projectScope, {
      operationId: opIdFor("0201"),
      owner: "control",
      leaseUntil: LATER,
      now: NOW,
    });
    opened.store.completeOperation(world.projectScope, {
      operationId: opIdFor("0201"),
      token: lease.token,
      owner: "control",
      resultDigest,
      now: NOW,
      updatedAt: NOW,
    });
    expect(() =>
      opened.store.leaseOperation(world.projectScope, {
        operationId: opIdFor("0201"),
        owner: "control",
        leaseUntil: LATER,
        now: LATER,
      }),
    ).toThrow(LeaseError);
  } finally {
    opened.close();
  }
});

test("enrollment secrets use versioned Argon2id verifiers", async () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-enroll");
    const secret = randomSecret();
    await opened.store.createEnrollmentChallenge(world.scope, {
      challengeId: "enroll-1",
      secret,
      permittedProjectsDigest: HOST_POLICY,
      expiresAt: LATER,
      createdByPrincipalId: world.scope.principalId,
      createdAt: NOW,
    });
    await expect(opened.store.verifyEnrollmentSecret("enroll-1", secret)).resolves.toBe(true);
    await expect(opened.store.verifyEnrollmentSecret("enroll-1", randomSecret())).resolves.toBe(
      false,
    );
  } finally {
    opened.close();
  }
});

test("duplicate host authority artifacts are content-addressed and ignored", () => {
  const opened = openTempStore();
  try {
    const first = {
      objectDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      schemaName: "PermittedProjects",
      mediaType: "application/json",
      byteSize: 8,
      encryptionKeyId: "host-key:enroll-a",
      encryptionNonce: "enroll-aaaaaaaaaaaaaaa",
      signatureKeyId: "host-sign",
      signature: "c2ln",
      createdAt: NOW,
    };
    opened.store.putHostAuthorityArtifact(first);
    opened.store.putHostAuthorityArtifact({
      ...first,
      encryptionKeyId: "host-key:enroll-b",
      encryptionNonce: "enroll-bbbbbbbbbbbbbbb",
    });
    expect(opened.store.getHostAuthorityArtifact(first.objectDigest)?.encryptionKeyId).toBe(
      "host-key:enroll-a",
    );
  } finally {
    opened.close();
  }
});

test("failed SPAWN_AGENT is not reclaimed; a new ready spawn is", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-spawn-fail");
    createTaskRun(opened.store, world, runIdFor("0202"));
    const inputDigest = digestOf("spawn-in");
    const errorDigest = digestOf("spawn-err");
    opened.store.putArtifact(world.projectScope, artifact(inputDigest, null, "spawn-in"));
    opened.store.putArtifact(world.projectScope, artifact(errorDigest, null, "spawn-err"));
    opened.store.enqueueOperation(world.projectScope, {
      operationId: opIdFor("0202"),
      runId: runIdFor("0202"),
      operationKind: "SPAWN_AGENT",
      dedupeKey: "spawn-1",
      inputDigest,
      createdAt: NOW,
    });
    const lease = opened.store.leaseOperation(world.projectScope, {
      operationId: opIdFor("0202"),
      owner: "worker-1",
      leaseUntil: LATER,
      now: NOW,
    });
    opened.store.failOperation(world.projectScope, {
      operationId: opIdFor("0202"),
      token: lease.token,
      owner: "worker-1",
      errorDigest,
      now: NOW,
      updatedAt: NOW,
    });
    opened.store.enqueueOperation(world.projectScope, {
      operationId: opIdFor("0203"),
      runId: runIdFor("0202"),
      operationKind: "SPAWN_AGENT",
      dedupeKey: "spawn-2",
      inputDigest,
      createdAt: LATER,
    });
    const claimable = opened.store.listClaimableOperations([world.projectId], LATER);
    expect(claimable.map((row) => row.operationId)).toEqual([opIdFor("0203")]);
  } finally {
    opened.close();
  }
});
