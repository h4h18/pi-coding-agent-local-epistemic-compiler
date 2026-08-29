import { expect, test } from "vitest";
import {
  artifact,
  bootstrapTrustedWorld,
  createTaskRun,
  digestOf,
  NOW,
  openTempStore,
  runIdFor,
} from "./helpers.js";

test("prepared to dispatching does not record an accepted transport attempt before HTTP", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-cloud-attempt");
    createTaskRun(opened.store, world, runIdFor("1501"));
    const req = digestOf("cloud-req-15");
    const ctx = digestOf("cloud-ctx-15");
    opened.store.putArtifact(world.projectScope, artifact(req, "CanonicalCloudRequest", "creq15"));
    opened.store.putArtifact(world.projectScope, artifact(ctx, "ContextPacket", "cctx15"));
    opened.store.createCloudCall(world.projectScope, {
      cloudCallId: "call-15",
      runId: runIdFor("1501"),
      purpose: "initial",
      deploymentId: "dep-1",
      requestDigest: req,
      contextPacketDigest: ctx,
      recoveryGrade: "C",
      state: "prepared",
      createdAt: NOW,
    });
    const owned = opened.store.transitionPreparedCloudCallToDispatching(world.projectScope, {
      cloudCallId: "call-15",
      requestDigest: req,
      attemptId: "att-unused",
      requestStartedAt: NOW,
      updatedAt: NOW,
    });
    expect(owned).toBe(true);
    expect(opened.store.listCloudTransportAttempts(world.projectScope, "call-15")).toEqual([]);
    opened.store.settleCloudCallTransport(world.projectScope, {
      cloudCallId: "call-15",
      requestStartedAt: NOW,
      updatedAt: NOW,
      attemptOutcome: "failed-before-acceptance",
      nextState: "prepared",
    });
    const attempts = opened.store.listCloudTransportAttempts(world.projectScope, "call-15");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("failed-before-acceptance");
    expect(opened.store.getCloudCall(world.projectScope, "call-15")?.state).toBe("prepared");
    const again = opened.store.transitionPreparedCloudCallToDispatching(world.projectScope, {
      cloudCallId: "call-15",
      requestDigest: req,
      attemptId: "att-unused-2",
      requestStartedAt: NOW,
      updatedAt: NOW,
    });
    expect(again).toBe(true);
  } finally {
    opened.close();
  }
});
