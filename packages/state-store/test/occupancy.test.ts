import { expect, test } from "vitest";
import {
  artifact,
  bootstrapTrustedWorld,
  cancelEvent,
  createTaskRun,
  digestOf,
  NOW,
  openTempStore,
  persistEnter,
  putPayload,
  reopenStore,
  runIdFor,
  verified,
} from "./helpers.js";
import { openSqliteFile } from "../src/sqlite.js";

test("occupancy follows nonterminal runs, CLOUD_OUTCOME_UNKNOWN, and does not leak across projects", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-occ");
    const other = bootstrapTrustedWorld(opened.store, "proj-occ-b");
    const { taskDigest } = createTaskRun(opened.store, world, runIdFor("0500"));
    expect(opened.store.isGcForbidden(world.projectScope, taskDigest)).toBe(true);
    expect(opened.store.isGcForbidden(other.projectScope, taskDigest)).toBe(false);

    const { taskDigest: snapTask } = createTaskRun(opened.store, world, runIdFor("0501"));
    const snapshotManifest = digestOf("occ-snapshot-manifest");
    const snapshotRoot = digestOf("occ-snapshot-root");
    const gitHistory = digestOf("occ-git-history");
    opened.store.putArtifact(world.projectScope, artifact(snapshotManifest, "SnapshotManifest", "occ-manifest"));
    opened.store.putArtifact(world.projectScope, artifact(snapshotRoot, null, "occ-root"));
    opened.store.putArtifact(world.projectScope, artifact(gitHistory, "GitHistoryManifest", "occ-git"));
    opened.store.createSnapshot(world.projectScope, {
      snapshotId: "snap-occ",
      workspaceId: world.workspaceId,
      rootDigest: snapshotRoot,
      manifestDigest: snapshotManifest,
      runnerId: world.runnerId,
      createdAt: NOW,
    });
    opened.store.bindSnapshotArtifact(world.projectScope, {
      snapshotId: "snap-occ",
      role: "git-history-manifest",
      artifactDigest: gitHistory,
      createdAt: NOW,
    });
    const taskOnly = verified([{ role: "task-envelope", objectDigest: snapTask }]);
    let currentSnap = persistEnter(
      opened.store,
      world.projectScope,
      opened.store.getRun(world.projectScope, runIdFor("0501")),
      "SNAPSHOT_REQUESTED",
      taskOnly,
      "evt-occ-1",
    );
    currentSnap = persistEnter(
      opened.store,
      world.projectScope,
      currentSnap,
      "SNAPSHOT_UPLOADING",
      taskOnly,
      "evt-occ-2",
    );
    currentSnap = persistEnter(
      opened.store,
      world.projectScope,
      currentSnap,
      "SNAPSHOT_VALIDATING",
      taskOnly,
      "evt-occ-3",
    );
    currentSnap = persistEnter(
      opened.store,
      world.projectScope,
      currentSnap,
      "SNAPSHOT_READY",
      verified([
        { role: "task-envelope", objectDigest: snapTask },
        { role: "snapshot-manifest", objectDigest: snapshotManifest },
      ]),
      "evt-occ-4",
    );
    expect(currentSnap.snapshotId).toBe("snap-occ");
    expect(opened.store.isGcForbidden(world.projectScope, snapshotRoot)).toBe(true);
    expect(opened.store.isGcForbidden(world.projectScope, gitHistory)).toBe(true);
    expect(opened.store.isGcForbidden(other.projectScope, snapshotRoot)).toBe(false);

    opened.store.close();
    const raw = openSqliteFile(opened.dbPath);
    raw
      .prepare("UPDATE runs SET state = 'CLOUD_OUTCOME_UNKNOWN' WHERE project_id = ? AND run_id = ?")
      .run(world.projectId, runIdFor("0500"));
    raw.close();
    const mid = reopenStore(opened);
    expect(mid.isGcForbidden(world.projectScope, taskDigest)).toBe(true);
    mid.close();

    const live = reopenStore(opened);
    try {
      const current = live.getRun(world.projectScope, runIdFor("0500"));
      expect(current.state).toBe("CLOUD_OUTCOME_UNKNOWN");
      const cancelReq = digestOf("occ-cancel-req");
      const suspended = digestOf("occ-suspended");
      live.putArtifact(world.projectScope, artifact(cancelReq, null, "occ-cr"));
      live.putArtifact(world.projectScope, artifact(suspended, null, "occ-sus"));
      const pendingArts = verified([
        { role: "task-envelope", objectDigest: taskDigest },
        { role: "cancellation-request", objectDigest: cancelReq },
        { role: "suspended-state-binding", objectDigest: suspended },
      ]);
      const event = cancelEvent(current, "evt-occ-cancel");
      const payloadDigest = putPayload(live, world.projectScope, event);
      const pending = live.persistRunEvent(world.projectScope, {
        event,
        artifacts: pendingArts,
        payloadDigest,
      });
      expect(pending.state).toBe("CANCELLATION_PENDING");
      const receipt = digestOf("occ-receipt");
      live.putArtifact(world.projectScope, artifact(receipt, "CancellationReceipt", "occ-receipt"));
      const settled = {
        schemaVersion: 1 as const,
        eventId: "evt-occ-settled",
        projectId: pending.projectId,
        runId: pending.runId,
        expectedStateVersion: pending.stateVersion,
        actorType: "control" as const,
        actorId: "actor-control",
        occurredAt: pending.updatedAt,
        eventType: "CANCELLATION_SETTLED" as const,
        payload: {
          cancellationReceiptObjectDigest: receipt,
          providerOutcome: "NOT_DISPATCHED" as const,
        },
      };
      const settledDigest = putPayload(live, world.projectScope, settled);
      const cancelled = live.persistRunEvent(world.projectScope, {
        event: settled,
        artifacts: verified([
          { role: "task-envelope", objectDigest: taskDigest },
          { role: "cancellation-receipt", objectDigest: receipt },
        ]),
        payloadDigest: settledDigest,
      });
      expect(cancelled.state).toBe("CANCELLED");
      expect(live.isGcForbidden(world.projectScope, taskDigest)).toBe(false);
    } finally {
      live.close();
    }
  } finally {
    opened.close();
  }
});
