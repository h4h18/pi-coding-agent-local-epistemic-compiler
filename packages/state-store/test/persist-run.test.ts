import { expect, test } from "vitest";
import { IllegalTransitionError } from "@pi-hec/domain";
import {
  CrashBeforeCommitError,
  SimulatedProcessTermination,
  StateVersionConflictError,
} from "../src/index.js";
import {
  artifact,
  bootstrapTrustedWorld,
  cancelEvent,
  createTaskRun,
  digestOf,
  enterEvent,
  NOW,
  openTempStore,
  persistEnter,
  putPayload,
  reopenStore,
  runIdFor,
  verified,
} from "./helpers.js";

test("CAS rejects a stale state_version and does not clobber", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-cas");
    const { projection, taskDigest } = createTaskRun(opened.store, world, runIdFor("0100"));
    const artifacts = verified([{ role: "task-envelope", objectDigest: taskDigest }]);
    const first = persistEnter(
      opened.store,
      world.projectScope,
      projection,
      "SNAPSHOT_REQUESTED",
      artifacts,
      "evt-snap-req",
    );
    expect(first.state).toBe("SNAPSHOT_REQUESTED");
    expect(first.stateVersion).toBe(1);
    const stale = {
      ...enterEvent(first, "SNAPSHOT_UPLOADING", "evt-stale"),
      expectedStateVersion: projection.stateVersion,
    };
    const payloadDigest = putPayload(opened.store, world.projectScope, stale);
    expect(() =>
      opened.store.persistRunEvent(world.projectScope, { event: stale, artifacts, payloadDigest }),
    ).toThrow(StateVersionConflictError);
    expect(opened.store.getRun(world.projectScope, runIdFor("0100")).state).toBe("SNAPSHOT_REQUESTED");
    expect(opened.store.getRun(world.projectScope, runIdFor("0100")).stateVersion).toBe(1);
  } finally {
    opened.close();
  }
});

test("SNAPSHOT_READY plus cancel persists CANCELLATION_PENDING", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-cancel");
    const { projection, taskDigest } = createTaskRun(opened.store, world, runIdFor("0101"));
    const snapshot = digestOf("snapshot-manifest-cancel");
    opened.store.putArtifact(
      world.projectScope,
      artifact(snapshot, "SnapshotManifest", "snap-cancel"),
    );
    const root = digestOf("snapshot-root-cancel");
    opened.store.putArtifact(world.projectScope, artifact(root, null, "snap-root-cancel"));
    opened.store.createSnapshot(world.projectScope, {
      snapshotId: "snap-cancel",
      workspaceId: world.workspaceId,
      rootDigest: root,
      manifestDigest: snapshot,
      runnerId: world.runnerId,
      createdAt: NOW,
    });
    const taskOnly = verified([{ role: "task-envelope", objectDigest: taskDigest }]);
    let current = persistEnter(
      opened.store,
      world.projectScope,
      projection,
      "SNAPSHOT_REQUESTED",
      taskOnly,
      "evt-1",
    );
    current = persistEnter(
      opened.store,
      world.projectScope,
      current,
      "SNAPSHOT_UPLOADING",
      taskOnly,
      "evt-2",
    );
    current = persistEnter(
      opened.store,
      world.projectScope,
      current,
      "SNAPSHOT_VALIDATING",
      taskOnly,
      "evt-3",
    );
    const readyArts = verified([
      { role: "task-envelope", objectDigest: taskDigest },
      { role: "snapshot-manifest", objectDigest: snapshot },
    ]);
    current = persistEnter(
      opened.store,
      world.projectScope,
      current,
      "SNAPSHOT_READY",
      readyArts,
      "evt-4",
    );
    expect(current.state).toBe("SNAPSHOT_READY");
    expect(current.snapshotId).toBe("snap-cancel");
    const cancelReq = digestOf("cancel-request");
    const suspended = digestOf("suspended-binding");
    opened.store.putArtifact(world.projectScope, artifact(cancelReq, null, "cancel-req"));
    opened.store.putArtifact(world.projectScope, artifact(suspended, null, "suspended"));
    const cancelArts = verified([
      { role: "task-envelope", objectDigest: taskDigest },
      { role: "cancellation-request", objectDigest: cancelReq },
      { role: "suspended-state-binding", objectDigest: suspended },
    ]);
    const event = cancelEvent(current, "evt-cancel");
    const payloadDigest = putPayload(opened.store, world.projectScope, event);
    const pending = opened.store.persistRunEvent(world.projectScope, {
      event,
      artifacts: cancelArts,
      payloadDigest,
    });
    expect(pending.state).toBe("CANCELLATION_PENDING");
    expect(pending.stateVersion).toBe(5);
    expect(opened.store.listRunEvents(world.projectScope, runIdFor("0101"))).toHaveLength(5);
  } finally {
    opened.close();
  }
});

test("illegal reducer transitions are not persisted", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-illegal");
    const { projection, taskDigest } = createTaskRun(opened.store, world, runIdFor("0102"));
    const artifacts = verified([{ role: "task-envelope", objectDigest: taskDigest }]);
    const event = enterEvent(projection, "SUCCEEDED", "evt-bad");
    const payloadDigest = putPayload(opened.store, world.projectScope, event);
    expect(() =>
      opened.store.persistRunEvent(world.projectScope, { event, artifacts, payloadDigest }),
    ).toThrow(IllegalTransitionError);
    expect(opened.store.getRun(world.projectScope, runIdFor("0102")).state).toBe("CREATED");
    expect(opened.store.listRunEvents(world.projectScope, runIdFor("0102"))).toHaveLength(0);
  } finally {
    opened.close();
  }
});

test("crash before commit rolls back event and projection", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-crash-before");
    const { projection, taskDigest } = createTaskRun(opened.store, world, runIdFor("0103"));
    const artifacts = verified([{ role: "task-envelope", objectDigest: taskDigest }]);
    opened.store.requestCrash("persistRunEvent", "before-commit");
    const event = enterEvent(projection, "SNAPSHOT_REQUESTED", "evt-before");
    const payloadDigest = putPayload(opened.store, world.projectScope, event);
    expect(() =>
      opened.store.persistRunEvent(world.projectScope, { event, artifacts, payloadDigest }),
    ).toThrow(CrashBeforeCommitError);
    const reopened = reopenStore(opened);
    try {
      const loaded = reopened.getRun(world.projectScope, runIdFor("0103"));
      expect(loaded.state).toBe("CREATED");
      expect(loaded.stateVersion).toBe(0);
      expect(reopened.listRunEvents(world.projectScope, runIdFor("0103"))).toHaveLength(0);
    } finally {
      reopened.close();
    }
  } finally {
    opened.close();
  }
});

test("crash after commit keeps event and projection together", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-crash-after");
    const { projection, taskDigest } = createTaskRun(opened.store, world, runIdFor("0104"));
    const artifacts = verified([{ role: "task-envelope", objectDigest: taskDigest }]);
    opened.store.requestCrash("persistRunEvent", "after-commit");
    const event = enterEvent(projection, "SNAPSHOT_REQUESTED", "evt-after");
    const payloadDigest = putPayload(opened.store, world.projectScope, event);
    expect(() =>
      opened.store.persistRunEvent(world.projectScope, { event, artifacts, payloadDigest }),
    ).toThrow(SimulatedProcessTermination);
    const reopened = reopenStore(opened);
    try {
      const loaded = reopened.getRun(world.projectScope, runIdFor("0104"));
      expect(loaded.state).toBe("SNAPSHOT_REQUESTED");
      expect(loaded.stateVersion).toBe(1);
      expect(reopened.listRunEvents(world.projectScope, runIdFor("0104"))).toHaveLength(1);
    } finally {
      reopened.close();
    }
  } finally {
    opened.close();
  }
});
