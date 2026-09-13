import { expect, test } from "vitest";
import { IMMUTABLE_TASKS } from "./fixtures.js";
import { frozenHoldoutPairs, HOLDOUT_PAIR_COUNT } from "./holdout-corpus.js";
import { RECORDED_OUTCOMES } from "./recorded.js";
import {
  claimProductionHoldout,
  evaluateSection24Gates,
  holdoutPairsFromOutcomes,
} from "./section24.js";
import { coverageStatus, HOLDOUT_MIN_PAIRS, REQUIRED_SLICES } from "./protocol.js";

test("tiny fixture set remains underpowered and cannot claim section 2.4", () => {
  const decision = evaluateSection24Gates({
    pairs: holdoutPairsFromOutcomes(IMMUTABLE_TASKS, RECORDED_OUTCOMES),
    postResultExclusions: [],
    roleIsolationPerfect: true,
  });
  expect(IMMUTABLE_TASKS.length).toBeLessThan(HOLDOUT_MIN_PAIRS);
  expect(coverageStatus(IMMUTABLE_TASKS).underpowered).toBe(true);
  expect(decision.holdoutGatesClaimed).toBe(false);
  expect(decision.gates.find((gate) => gate.id === "frozen-powered-holdout")?.passed).toBe(false);
});

test("frozen 1000-pair holdout claims every section 2.4 gate", () => {
  const pairs = frozenHoldoutPairs();
  expect(pairs).toHaveLength(HOLDOUT_PAIR_COUNT);
  for (const slice of REQUIRED_SLICES) {
    expect(pairs.filter((pair) => pair.task.sliceTags.includes(slice)).length).toBeGreaterThanOrEqual(
      100,
    );
  }
  const weight = pairs.reduce((sum, pair) => sum + pair.task.weight, 0);
  expect(weight).toBeCloseTo(1);
  const decision = claimProductionHoldout();
  expect(decision.gates.filter((gate) => !gate.passed)).toEqual([]);
  expect(decision.holdoutGatesClaimed).toBe(true);
});
