import path from "node:path";
import { ARM_IDS } from "./types.js";
import type { EligibilityDecision, FrozenEnvironment, PairedTrial, TaskFixture } from "./types.js";

export type EligibilityInput = {
  readonly taskId: string;
  readonly snapshotId: string;
  readonly snapshotRootDigest: string;
  readonly broken: boolean;
  readonly ambiguous: boolean;
};

export function decideEligibility(input: EligibilityInput): EligibilityDecision {
  if (input.broken) {
    return {
      taskId: input.taskId,
      snapshotId: input.snapshotId,
      eligible: false,
      reason: "broken-snapshot",
      decidedBeforeReveal: true,
    };
  }
  if (input.ambiguous) {
    return {
      taskId: input.taskId,
      snapshotId: input.snapshotId,
      eligible: false,
      reason: "ambiguous-snapshot",
      decidedBeforeReveal: true,
    };
  }
  if (input.snapshotId.length === 0 || input.snapshotRootDigest.length === 0) {
    return {
      taskId: input.taskId,
      snapshotId: input.snapshotId,
      eligible: false,
      reason: "broken-snapshot",
      decidedBeforeReveal: true,
    };
  }
  return {
    taskId: input.taskId,
    snapshotId: input.snapshotId,
    eligible: true,
    reason: "eligible",
    decidedBeforeReveal: true,
  };
}

export function pairTrial(input: {
  readonly task: TaskFixture;
  readonly environment: FrozenEnvironment;
  readonly workspaceRoot: string;
  readonly eligibility: EligibilityDecision;
}): PairedTrial {
  if (input.eligibility.taskId !== input.task.taskId || input.eligibility.snapshotId !== input.task.snapshotId) {
    throw new Error("eligibility was not decided on this task snapshot");
  }
  const workspaces = {
    1: path.join(input.workspaceRoot, input.task.taskId, "arm-1-ordinary-pi"),
    2: path.join(input.workspaceRoot, input.task.taskId, "arm-2-one-shot-no-aep"),
    3: path.join(input.workspaceRoot, input.task.taskId, "arm-3-hec-first"),
    4: path.join(input.workspaceRoot, input.task.taskId, "arm-4-hec-repair"),
  };
  const unique = new Set(ARM_IDS.map((arm) => workspaces[arm]));
  if (unique.size !== ARM_IDS.length) {
    throw new Error("arm workspaces must be independent pristine copies");
  }
  return {
    taskId: input.task.taskId,
    snapshotId: input.task.snapshotId,
    deploymentId: input.environment.deploymentId,
    environmentId: input.environment.environmentId,
    repositoryCommit: input.task.repositoryCommit,
    eligibility: input.eligibility,
    workspaces,
  };
}
