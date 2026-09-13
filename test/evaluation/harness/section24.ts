import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pairedCompletionOneSided,
  pairedSuccessBootstrap,
  type PairedCompletion,
  type PairedSuccess,
} from "./bootstrap.js";
import { frozenHoldoutPairs, type HoldoutPair } from "./holdout-corpus.js";
import { countCompletionsFromLedger } from "./ledger.js";
import { roleIsolationScore } from "../local-model/metrics.js";
import { scoreArm, wilsonUpperBound, type ArmOutcome } from "./metrics.js";
import { FROZEN_ENVIRONMENT } from "./fixtures.js";
import { coverageStatus, HOLDOUT_MIN_PAIRS, REQUIRED_SLICES } from "./protocol.js";
import type { SliceTag, TaskFixture } from "./types.js";

const BOOTSTRAP_DRAWS = 399;
const RELATIVE_UPLIFT = 0.2;
const ABSOLUTE_UPLIFT = 0.08;
const FVR_WILSON_MAX = 0.01;
const SLICE_REGRESSION_MAX = 0.02;

export type Section24GateId =
  | "strict1c-uplift"
  | "strict1c-ci"
  | "mean-completions-ci"
  | "p95-completions-ci"
  | "false-verified-rate"
  | "slice-non-regression"
  | "role-isolation"
  | "frozen-powered-holdout";

export type Section24Gate = {
  readonly id: Section24GateId;
  readonly passed: boolean;
};

export type Section24Decision = {
  readonly holdoutGatesClaimed: boolean;
  readonly gates: readonly Section24Gate[];
};

export function completionRowsFromPairs(pairs: readonly HoldoutPair[]): PairedCompletion[] {
  return pairs.map((pair) => ({
    taskId: pair.task.taskId,
    repositoryId: pair.task.repositoryId,
    weight: pair.task.weight,
    completions: countCompletionsFromLedger(pair.hec.ledger),
    baselineCompletions: countCompletionsFromLedger(pair.baseline.ledger),
    hecCompletions: countCompletionsFromLedger(pair.hec.ledger),
  }));
}

export function successRowsFromPairs(pairs: readonly HoldoutPair[]): PairedSuccess[] {
  return pairs.map((pair) => ({
    taskId: pair.task.taskId,
    repositoryId: pair.task.repositoryId,
    weight: pair.task.weight,
    hecSuccess: scoreArm(pair.hec).strict1c ? 1 : 0,
    baselineSuccess: scoreArm(pair.baseline).strict1c ? 1 : 0,
  }));
}

function rate(values: readonly boolean[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.filter((value) => value).length / values.length;
}

function sliceRate(pairs: readonly HoldoutPair[], slice: SliceTag, arm: "hec" | "baseline"): number {
  const rows = pairs.filter((pair) => pair.task.sliceTags.includes(slice));
  return rate(rows.map((pair) => scoreArm(arm === "hec" ? pair.hec : pair.baseline).strict1c));
}

export function committedRoleIsolationPerfect(): boolean {
  const filePath = path.resolve(
    fileURLToPath(new URL("../local-model/fixtures/datasets/role-isolation.jsonl", import.meta.url)),
  );
  const rows = readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { invokedCloudCompletion: boolean; invokedRepositoryTool: boolean });
  return roleIsolationScore(rows) === 1;
}

export function evaluateSection24Gates(input: {
  readonly pairs: readonly HoldoutPair[];
  readonly postResultExclusions?: readonly string[];
  readonly roleIsolationPerfect?: boolean;
  readonly seed?: number;
  readonly draws?: number;
}): Section24Decision {
  const pairs = input.pairs;
  const tasks = pairs.map((pair) => pair.task);
  const coverage = coverageStatus(tasks);
  const seed = input.seed ?? FROZEN_ENVIRONMENT.prngSeed;
  const draws = input.draws ?? BOOTSTRAP_DRAWS;
  const hecStrict = rate(pairs.map((pair) => scoreArm(pair.hec).strict1c));
  const baselineStrict = rate(pairs.map((pair) => scoreArm(pair.baseline).strict1c));
  const relativePass = baselineStrict === 0 ? hecStrict > 0 : hecStrict >= baselineStrict * (1 + RELATIVE_UPLIFT);
  const absolutePass = hecStrict - baselineStrict >= ABSOLUTE_UPLIFT;
  const successCi = pairedSuccessBootstrap(successRowsFromPairs(pairs), seed, draws);
  const completionOneSided = pairedCompletionOneSided(completionRowsFromPairs(pairs), seed, draws);
  const hecAccepted = pairs.filter((pair) => pair.hec.localVerdict === "ACCEPTED");
  const hecFalseVerified = hecAccepted.filter((pair) => scoreArm(pair.hec).falseVerified).length;
  const fvrWilson = wilsonUpperBound(hecFalseVerified, hecAccepted.length);
  const fvr = hecAccepted.length === 0 ? 1 : hecFalseVerified / hecAccepted.length;
  const baselineFalseSuccess = rate(pairs.map((pair) => scoreArm(pair.baseline).falseSuccess));
  const slicePass = REQUIRED_SLICES.every((slice) => {
    const count = pairs.filter((pair) => pair.task.sliceTags.includes(slice)).length;
    if (count < 100) {
      return false;
    }
    return sliceRate(pairs, slice, "hec") - sliceRate(pairs, slice, "baseline") >= -SLICE_REGRESSION_MAX;
  });
  const exclusions = input.postResultExclusions ?? [];
  const roleIsolationPerfect = input.roleIsolationPerfect ?? committedRoleIsolationPerfect();
  const gates: Section24Gate[] = [
    { id: "strict1c-uplift", passed: relativePass || absolutePass },
    { id: "strict1c-ci", passed: successCi.lower > 0 },
    { id: "mean-completions-ci", passed: completionOneSided.meanUpper <= 0 },
    { id: "p95-completions-ci", passed: completionOneSided.p95Upper <= 0 },
    { id: "false-verified-rate", passed: fvrWilson < FVR_WILSON_MAX && fvr <= baselineFalseSuccess },
    { id: "slice-non-regression", passed: slicePass && coverage.underpoweredSlices.length === 0 },
    { id: "role-isolation", passed: roleIsolationPerfect },
    {
      id: "frozen-powered-holdout",
      passed:
        !coverage.underpowered &&
        coverage.pairCount >= HOLDOUT_MIN_PAIRS &&
        exclusions.length === 0,
    },
  ];
  return {
    holdoutGatesClaimed: gates.every((gate) => gate.passed),
    gates,
  };
}

export function holdoutPairsFromOutcomes(
  tasks: readonly TaskFixture[],
  outcomes: readonly ArmOutcome[],
): HoldoutPair[] {
  return tasks.map((task) => {
    const baseline = outcomes.find((item) => item.taskId === task.taskId && item.armId === 1);
    const hec = outcomes.find((item) => item.taskId === task.taskId && item.armId === 3);
    if (baseline === undefined || hec === undefined) {
      throw new Error(`missing recorded pair for ${task.taskId}`);
    }
    return { task, baseline, hec };
  });
}

export function claimProductionHoldout(): Section24Decision {
  return evaluateSection24Gates({
    pairs: frozenHoldoutPairs(),
    postResultExclusions: [],
    roleIsolationPerfect: committedRoleIsolationPerfect(),
    seed: FROZEN_ENVIRONMENT.prngSeed,
  });
}
