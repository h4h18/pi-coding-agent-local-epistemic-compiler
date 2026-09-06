import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { Compile } from "typebox/compile";
import { CloudDispatchSchema } from "@pi-hec/contracts";
import { rejectDiagnosticGateEvidence } from "./arms.js";
import { pairedBootstrap } from "./bootstrap.js";
import { runEvaluationHarness } from "./evaluate.js";
import { FROZEN_ENVIRONMENT, IMMUTABLE_TASKS } from "./fixtures.js";
import { countCompletionsFromLedger } from "./ledger.js";
import {
  blockRandomizeOrder,
  coverageStatus,
  freezeManifest,
  HOLDOUT_MIN_PAIRS,
} from "./protocol.js";
import { scoreArm } from "./metrics.js";
import { RECORDED_OUTCOMES } from "./recorded.js";

const DISPATCH = Compile(CloudDispatchSchema);

test("frozen fixture set stays tiny and never claims a 1000-pair holdout gate", () => {
  expect(IMMUTABLE_TASKS.map((task) => task.dataset).sort()).toEqual([
    "adversarial-injection",
    "undetermined-oracle",
    "unknown-language-polyglot",
  ]);
  const manifest = freezeManifest();
  expect(manifest.holdoutGatesClaimed).toBe(false);
  expect(manifest.piVersion).toBe("0.84.3");
  expect(manifest.holdoutNFrozen).toBeLessThan(HOLDOUT_MIN_PAIRS);
  expect(coverageStatus(IMMUTABLE_TASKS).underpowered).toBe(true);
  expect(() => {
    rejectDiagnosticGateEvidence(2);
  }).toThrow(/diagnostic/);
  expect(() => {
    rejectDiagnosticGateEvidence(4);
  }).toThrow(/diagnostic/);
});

test("checked-in bootstrap is deterministic for the frozen PRNG seed", () => {
  const pairs = IMMUTABLE_TASKS.map((task) => {
    const baseline = RECORDED_OUTCOMES.find(
      (item) => item.taskId === task.taskId && item.armId === 1,
    );
    const hec = RECORDED_OUTCOMES.find((item) => item.taskId === task.taskId && item.armId === 3);
    if (baseline === undefined || hec === undefined) {
      throw new Error("missing pair");
    }
    return {
      taskId: task.taskId,
      repositoryId: task.repositoryId,
      weight: task.weight,
      completions: countCompletionsFromLedger(hec.ledger),
      baselineCompletions: countCompletionsFromLedger(baseline.ledger),
      hecCompletions: countCompletionsFromLedger(hec.ledger),
    };
  });
  const first = pairedBootstrap(pairs, FROZEN_ENVIRONMENT.prngSeed, 32);
  const second = pairedBootstrap(pairs, FROZEN_ENVIRONMENT.prngSeed, 32);
  expect(first).toEqual(second);
});

test("evaluate invokes baseline and HEC runners with a schema-valid CloudDispatch", async () => {
  let baselineCalls = 0;
  let hecCalls = 0;
  const reportDir = mkdtempSync(path.join(tmpdir(), "hec-eval-invoke-"));
  const result = await runEvaluationHarness({
    reportDir,
    createBaselineSession: () => {
      baselineCalls += 1;
      return Promise.resolve({
        session: {
          prompt: () => Promise.resolve(),
          getSessionStats: () => ({ assistantMessages: 2 }),
        },
      });
    },
    hecCompleteOnce: (dispatch) => {
      hecCalls += 1;
      expect(DISPATCH.Check(dispatch)).toBe(true);
      expect(Object.keys(dispatch).sort()).toEqual([
        "conversation",
        "egress",
        "request",
        "wireRequest",
      ]);
      return Promise.resolve({ state: "accepted-outcome-unknown" });
    },
  });
  expect(baselineCalls).toBe(IMMUTABLE_TASKS.length);
  expect(hecCalls).toBe(IMMUTABLE_TASKS.length);
  expect(result.baselinePromptTurns).toEqual(IMMUTABLE_TASKS.map(() => 2));
  expect(result.trialOrder).toEqual(
    blockRandomizeOrder(
      IMMUTABLE_TASKS.map((task) => task.taskId),
      FROZEN_ENVIRONMENT.prngSeed,
    ),
  );
  expect(
    result.publishedArms.filter((row) => row.armId === 1).every((row) => row.promptTurns === 2),
  ).toBe(true);
  expect(
    result.publishedArms
      .filter((row) => row.armId === 3)
      .every((row) => row.hecState === "accepted-outcome-unknown"),
  ).toBe(true);
  for (const row of result.publishedWorkspaces) {
    expect(existsSync(row)).toBe(true);
  }
  expect(result.holdoutGatesClaimed).toBe(false);
  const noOracleTask = IMMUTABLE_TASKS.find((task) => task.noOracle);
  expect(noOracleTask).toBeDefined();
  const noOracleArms = result.publishedArms.filter((row) => row.taskId === noOracleTask?.taskId);
  expect(noOracleArms).toHaveLength(2);
  expect(noOracleArms.every((row) => row.noOracle === true && scoreArm(row).undetermined)).toBe(
    true,
  );
});

test("arm-specific runner throw does not abort evaluate and marks only that arm unsuccessful", async () => {
  const reportDir = mkdtempSync(path.join(tmpdir(), "hec-eval-arm-fail-"));
  const result = await runEvaluationHarness({
    reportDir,
    createBaselineSession: () => {
      throw new Error("baseline protocol failure");
    },
    hecCompleteOnce: () => Promise.resolve({ state: "completed" }),
  });
  expect(result.reports.length).toBeGreaterThan(0);
  expect(result.holdoutGatesClaimed).toBe(false);
  const baselines = result.publishedArms.filter((row) => row.armId === 1);
  const hecs = result.publishedArms.filter((row) => row.armId === 3);
  expect(baselines.length).toBe(IMMUTABLE_TASKS.length);
  expect(hecs.length).toBe(IMMUTABLE_TASKS.length);
  expect(baselines.every((row) => row.timeout || row.protocolFailure || row.missingOutput)).toBe(
    true,
  );
  expect(
    baselines.every((row) => !scoreArm(row).strict1c && !scoreArm(row).finalVerifiedSuccess),
  ).toBe(true);
  const polyglotBaseline = baselines.find((row) => row.taskId === "eval-polyglot-001");
  if (polyglotBaseline === undefined) {
    throw new Error("expected polyglot baseline row");
  }
  expect(scoreArm(polyglotBaseline).falseSuccess).toBe(false);
  expect(scoreArm(polyglotBaseline).automaticIncorrect).toBe(false);
  expect(hecs.every((row) => row.hecState === "completed")).toBe(true);
});

test("HEC runner throw leaves baseline scored and still writes reports", async () => {
  const reportDir = mkdtempSync(path.join(tmpdir(), "hec-eval-hec-fail-"));
  const result = await runEvaluationHarness({
    reportDir,
    createBaselineSession: () =>
      Promise.resolve({
        session: {
          prompt: () => Promise.resolve(),
          getSessionStats: () => ({ assistantMessages: 1 }),
        },
      }),
    hecCompleteOnce: () => {
      throw new Error("hec timeout");
    },
  });
  expect(result.reports.length).toBeGreaterThan(0);
  const baselines = result.publishedArms.filter((row) => row.armId === 1);
  const hecs = result.publishedArms.filter((row) => row.armId === 3);
  expect(baselines.every((row) => row.promptTurns === 1)).toBe(true);
  expect(hecs.every((row) => row.timeout || row.protocolFailure || row.missingOutput)).toBe(true);
  expect(hecs.every((row) => !scoreArm(row).strict1c)).toBe(true);
  const polyglotHec = hecs.find((row) => row.taskId === "eval-polyglot-001");
  if (polyglotHec === undefined) {
    throw new Error("expected polyglot HEC row");
  }
  expect(scoreArm(polyglotHec).falseVerified).toBe(false);
  expect(scoreArm(polyglotHec).automaticIncorrect).toBe(false);
  const injection = baselines.find((row) => row.securityBreach);
  if (injection === undefined) {
    throw new Error("expected security-breach baseline row");
  }
  expect(scoreArm(injection).automaticIncorrect).toBe(true);
});
