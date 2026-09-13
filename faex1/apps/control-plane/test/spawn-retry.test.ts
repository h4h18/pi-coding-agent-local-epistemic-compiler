import { afterAll, beforeAll, expect, test } from "vitest";
import { requeueRetryingAgentWork } from "../src/services/agent-jobs.js";
import { hostAdminScope, newOperationId, persistCasArtifact } from "../src/orchestration/handlers.js";
import { PROJECT_ID, RUN_ID, startHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
  }
});

function requireHarness(): Harness {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  return harness;
}

test("startup requeue turns a retrying implementer into a ready SPAWN_AGENT", async () => {
  const current = requireHarness();
  const ctx = current.listening.ctx;
  const admin = hostAdminScope(ctx);
  const scope = ctx.store.toProjectScope(admin, PROJECT_ID);
  const now = ctx.clock();
  const accepted = [
    "analyst",
    "code-investigator",
    "spec-investigator",
    "planner",
  ] as const;
  ctx.store.upsertAgentNode(scope, {
    runId: RUN_ID,
    nodeId: "profile",
    attempt: 1,
    status: "ACCEPTED",
    operation: "FEATURE",
    idempotencyKey: `${RUN_ID}:profile:1`,
    updatedAt: now,
  });
  for (const nodeId of accepted) {
    ctx.store.upsertAgentNode(scope, {
      runId: RUN_ID,
      nodeId,
      attempt: 1,
      status: "ACCEPTED",
      role: nodeId === "planner" ? "planner" : nodeId === "analyst" ? "analyst" : "investigator",
      idempotencyKey: `${RUN_ID}:${nodeId}:1`,
      updatedAt: now,
    });
  }
  ctx.store.upsertAgentNode(scope, {
    runId: RUN_ID,
    nodeId: "implementer",
    attempt: 2,
    status: "RETRYING",
    role: "implementer",
    idempotencyKey: `${RUN_ID}:implementer:2`,
    updatedAt: now,
  });
  expect(ctx.store.listRetryingAgentRuns()).toEqual([{ projectId: PROJECT_ID, runId: RUN_ID }]);
  const queued = await requeueRetryingAgentWork({
    store: ctx.store,
    adminScope: admin,
    now,
    persistArtifact: async (projectId, bytes, schemaName) =>
      persistCasArtifact(ctx, admin, projectId, bytes, "application/json", "internal", schemaName),
    newOperationId,
  });
  expect(queued).toBe(1);
  const spawnOps = ctx.store
    .listOperations(scope)
    .filter((row) => row.operationKind === "SPAWN_AGENT" && row.dedupeKey.includes(":implementer:"));
  expect(spawnOps.some((row) => row.state === "ready" && row.dedupeKey.endsWith(":implementer:2"))).toBe(
    true,
  );
  expect(ctx.store.listRetryingAgentRuns()).toEqual([]);
});
