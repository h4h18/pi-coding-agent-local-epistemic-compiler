import type { ObjectDigest } from "@pi-hec/contracts";
import type { StateStore } from "@pi-hec/state-store";
import {
  artifact,
  bootstrapTrustedWorld,
  createTaskRun,
  digestOf,
  NOW,
  openTempStore,
  runIdFor,
  type OpenedStore,
  type World,
} from "../../state-store/test/helpers.js";

export { NOW, digestOf, openTempStore, runIdFor };
export type { OpenedStore, World };

export const DAY = "2026-08-28";
export const RUN_A = runIdFor("2201");
export const RUN_B = runIdFor("2202");

export function seedUsageWorld(store: StateStore, projectId: string): World {
  return bootstrapTrustedWorld(store, projectId);
}

export function seedRunWithCall(
  store: StateStore,
  world: World,
  runId: ReturnType<typeof runIdFor>,
  cloudCallId: string,
  state: "prepared" | "completed" = "completed",
): void {
  createTaskRun(store, world, runId);
  const req = digestOf(`cloud-req:${cloudCallId}`);
  const ctx = digestOf(`cloud-ctx:${cloudCallId}`);
  store.putArtifact(world.projectScope, artifact(req, "CanonicalCloudRequest", `creq:${cloudCallId}`));
  store.putArtifact(world.projectScope, artifact(ctx, "ContextPacket", `cctx:${cloudCallId}`));
  const response = digestOf(`cloud-res:${cloudCallId}`);
  if (state === "completed") {
    store.putArtifact(world.projectScope, artifact(response, "CloudCompletionReceipt", `cres:${cloudCallId}`));
  }
  store.createCloudCall(world.projectScope, {
    cloudCallId,
    runId,
    purpose: "initial",
    deploymentId: "dep-1",
    requestDigest: req,
    contextPacketDigest: ctx,
    recoveryGrade: "C",
    state,
    createdAt: NOW,
    ...(state === "completed" ? { responseDigest: response } : {}),
  });
}

export function putPricingSnapshot(store: StateStore, world: World, label: string): ObjectDigest {
  const digest = digestOf(`pricing:${label}`);
  store.putArtifact(world.projectScope, artifact(digest, null, `pricing:${label}`));
  return digest;
}

