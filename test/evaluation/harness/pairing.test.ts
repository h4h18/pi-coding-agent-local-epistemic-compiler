import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ARM_DEFINITIONS, isProductionGateArm } from "./arms.js";
import { decideEligibility, pairTrial } from "./pairing.js";
import { IMMUTABLE_TASKS, FROZEN_ENVIRONMENT } from "./fixtures.js";

test("same task deployment and environment are paired and eligibility is decided before arm outcomes are visible", () => {
  const task = IMMUTABLE_TASKS[0];
  if (task === undefined) {
    throw new Error("missing polyglot fixture");
  }
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "hec-eval-pair-"));
  const leaked = { arm1Success: true, arm3Success: false, goldPatch: task.goldPatchRef };
  const eligibility = decideEligibility({
    taskId: task.taskId,
    snapshotId: task.snapshotId,
    snapshotRootDigest: task.snapshotRootDigest,
    broken: task.broken,
    ambiguous: task.ambiguous,
  });
  expect(eligibility.decidedBeforeReveal).toBe(true);
  expect(eligibility.eligible).toBe(true);
  expect(Object.keys(eligibility).includes("arm1Success")).toBe(false);
  const paired = pairTrial({
    task,
    environment: FROZEN_ENVIRONMENT,
    workspaceRoot,
    eligibility,
  });
  expect(paired.taskId).toBe(task.taskId);
  expect(paired.snapshotId).toBe(task.snapshotId);
  expect(paired.deploymentId).toBe(FROZEN_ENVIRONMENT.deploymentId);
  expect(paired.environmentId).toBe(FROZEN_ENVIRONMENT.environmentId);
  expect(paired.repositoryCommit).toBe(task.repositoryCommit);
  expect(paired.eligibility).toEqual(eligibility);
  expect(paired.workspaces[1]).not.toBe(paired.workspaces[3]);
  expect(paired.workspaces[1]).toContain(task.taskId);
  expect(paired.workspaces[3]).toContain(task.taskId);
  expect(JSON.stringify(paired)).not.toContain("arm1Success");
  expect(JSON.stringify(paired)).not.toContain(leaked.goldPatch);
  expect(JSON.stringify(paired)).not.toContain("goldPatch");
});

test("arms 2 and 4 are diagnostic and rejected as production-gate evidence", () => {
  expect(ARM_DEFINITIONS[1].role).toBe("primary");
  expect(ARM_DEFINITIONS[3].role).toBe("primary");
  expect(ARM_DEFINITIONS[2].role).toBe("diagnostic");
  expect(ARM_DEFINITIONS[4].role).toBe("diagnostic");
  expect(isProductionGateArm(1)).toBe(true);
  expect(isProductionGateArm(3)).toBe(true);
  expect(isProductionGateArm(2)).toBe(false);
  expect(isProductionGateArm(4)).toBe(false);
});
