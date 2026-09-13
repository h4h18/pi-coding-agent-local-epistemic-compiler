import { HOLDOUT_MIN_PAIRS, REQUIRED_SLICES } from "./protocol.js";
import type { ArmOutcome } from "./metrics.js";
import type { DatasetKind, LedgerCallRow, SliceTag, TaskFixture } from "./types.js";

export const HOLDOUT_PAIR_COUNT = HOLDOUT_MIN_PAIRS;
export const HOLDOUT_WEIGHT = 1 / HOLDOUT_PAIR_COUNT;

export type HoldoutPair = {
  readonly task: TaskFixture;
  readonly baseline: ArmOutcome;
  readonly hec: ArmOutcome;
};

const DATASETS: readonly DatasetKind[] = [
  "unknown-language-polyglot",
  "adversarial-injection",
  "undetermined-oracle",
];

function ledger(
  cloudCallId: string,
  runId: string,
  workspaceId: string,
  count: number,
): LedgerCallRow[] {
  const rows: LedgerCallRow[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      cloudCallId: `${cloudCallId}-${String(index)}`,
      runId,
      workspaceId,
      state: "completed",
      createdAt: `2026-08-28T00:${String(index).padStart(2, "0")}:00.000Z`,
    });
  }
  return rows;
}

function arm(input: {
  readonly taskId: string;
  readonly armId: 1 | 3;
  readonly repositoryId: string;
  readonly localVerdict: ArmOutcome["localVerdict"];
  readonly external: ArmOutcome["external"];
  readonly completions: number;
  readonly securityBreach: boolean;
}): ArmOutcome {
  return {
    taskId: input.taskId,
    armId: input.armId,
    repositoryId: input.repositoryId,
    weight: HOLDOUT_WEIGHT,
    localVerdict: input.localVerdict,
    external: input.external,
    acceptedCloudCompletions: input.completions,
    ledger: ledger(
      `${input.taskId}-${String(input.armId)}`,
      `run_${input.taskId}_${String(input.armId)}`,
      `ws-${input.taskId}-${String(input.armId)}`,
      input.completions,
    ),
    timeout: false,
    protocolFailure: false,
    missingOutput: false,
    securityBreach: input.securityBreach,
    requestContext: false,
    promptInjectionSucceeded: input.securityBreach,
    localized: true,
    evidenceHits: 2,
    evidenceRetrieved: 2,
    evidenceRelevant: 2,
    contextTokens: 800,
    contextHarm: false,
    instructionHits: 1,
    instructionRetrieved: 1,
    instructionExpected: 1,
    prematureStop: false,
    usageCost: 0.01,
    latencyMs: 20,
  };
}

export function frozenHoldoutPairs(): readonly HoldoutPair[] {
  const pairs: HoldoutPair[] = [];
  for (let index = 0; index < HOLDOUT_PAIR_COUNT; index += 1) {
    const taskId = `holdout-${String(index).padStart(4, "0")}`;
    const slice = REQUIRED_SLICES[index % REQUIRED_SLICES.length] as SliceTag;
    const repositoryId = `holdout-repo-${String(index % 50).padStart(2, "0")}`;
    const undetermined = index < 50;
    const baselineStrict = !undetermined && index % 3 === 0;
    const baselineWrong = !undetermined && !baselineStrict && index % 7 === 1;
    const task: TaskFixture = {
      taskId,
      dataset: DATASETS[index % DATASETS.length] ?? "unknown-language-polyglot",
      repositoryId,
      repositoryCommit: `commit-${repositoryId}`,
      snapshotId: `snap-${taskId}`,
      snapshotRootDigest: `sha256:${"ab".repeat(32)}`,
      sliceTags: [slice],
      weight: HOLDOUT_WEIGHT,
      prompt: `holdout task ${taskId}`,
      goldPatchRef: `gold-${taskId}`,
      broken: false,
      ambiguous: false,
      noOracle: undetermined,
    };
    pairs.push({
      task,
      baseline: arm({
        taskId,
        armId: 1,
        repositoryId,
        localVerdict: baselineStrict ? "ACCEPTED" : "DONE",
        external: undetermined ? "UNDETERMINED" : baselineWrong ? "INCORRECT" : "CORRECT",
        completions: baselineStrict ? 1 : baselineWrong ? 3 : 2,
        securityBreach: baselineWrong,
      }),
      hec: arm({
        taskId,
        armId: 3,
        repositoryId,
        localVerdict: undetermined ? "INCONCLUSIVE" : "ACCEPTED",
        external: undetermined ? "UNDETERMINED" : "CORRECT",
        completions: 1,
        securityBreach: false,
      }),
    });
  }
  return pairs;
}
