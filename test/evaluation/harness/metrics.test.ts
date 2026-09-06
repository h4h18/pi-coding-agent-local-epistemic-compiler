import { expect, test } from "vitest";
import { countCompletionsFromLedger } from "./ledger.js";
import { aggregateMetrics, scoreArm, type ArmOutcome } from "./metrics.js";
import { RECORDED_OUTCOMES } from "./recorded.js";

function outcome(
  overrides: Partial<ArmOutcome> & Pick<ArmOutcome, "armId" | "taskId">,
): ArmOutcome {
  return {
    repositoryId: "repo",
    weight: 1,
    localVerdict: "ACCEPTED",
    external: "CORRECT",
    acceptedCloudCompletions: 1,
    ledger: [
      {
        cloudCallId: `${overrides.taskId}-${String(overrides.armId)}`,
        runId: "run",
        workspaceId: "ws",
        state: "completed",
        createdAt: "2026-08-28T00:00:00.000Z",
      },
    ],
    timeout: false,
    protocolFailure: false,
    missingOutput: false,
    securityBreach: false,
    requestContext: false,
    promptInjectionSucceeded: false,
    localized: true,
    evidenceHits: 1,
    evidenceRetrieved: 1,
    evidenceRelevant: 1,
    contextTokens: 100,
    contextHarm: false,
    instructionHits: 1,
    instructionRetrieved: 3,
    instructionExpected: 2,
    prematureStop: false,
    usageCost: 0,
    latencyMs: 1,
    ...overrides,
  };
}

test("headline metrics are per primary arm and paired HEC minus baseline from the same rows", () => {
  const metrics = aggregateMetrics(RECORDED_OUTCOMES);
  expect(metrics.baseline.completions.mean).not.toBe(metrics.hecFirst.completions.mean);
  expect(metrics.baseline.completions.p95).toBe(3);
  expect(metrics.hecFirst.completions.p95).toBe(2);
  expect(metrics.pairedDelta.completions.mean).toBeCloseTo(
    metrics.hecFirst.completions.mean - metrics.baseline.completions.mean,
  );
  expect(metrics.baseline.strict1c).not.toBe(metrics.hecFirst.strict1c);
  expect(metrics.baseline.operationalStrict1c).toBe(0);
  expect(metrics.hecFirst.operationalStrict1c).toBeCloseTo(1 / 3);
  expect(metrics.repairUplift).toBe(0);
});

test("repair uplift uses arm 3 vs arm 4 only when both exist", () => {
  const withoutRepair = aggregateMetrics([
    outcome({ taskId: "t1", armId: 3, localVerdict: "ACCEPTED" }),
  ]);
  expect(withoutRepair.repairUplift).toBe(0);
  const withRepair = aggregateMetrics([
    outcome({ taskId: "t1", armId: 3, localVerdict: "REJECTED", external: "INCORRECT" }),
    outcome({ taskId: "t1", armId: 4, localVerdict: "ACCEPTED", external: "CORRECT" }),
  ]);
  expect(withRepair.repairUplift).toBe(1);
});

test("localization evidence harm injection and premature-stop are per primary arm", () => {
  const metrics = aggregateMetrics([
    outcome({
      taskId: "t1",
      armId: 1,
      localized: true,
      contextHarm: false,
      promptInjectionSucceeded: false,
      prematureStop: false,
      evidenceHits: 2,
      evidenceRetrieved: 2,
      evidenceRelevant: 2,
    }),
    outcome({
      taskId: "t1",
      armId: 3,
      localized: true,
      contextHarm: false,
      promptInjectionSucceeded: false,
      prematureStop: false,
      evidenceHits: 1,
      evidenceRetrieved: 1,
      evidenceRelevant: 1,
    }),
    outcome({
      taskId: "t1",
      armId: 2,
      localized: false,
      contextHarm: true,
      promptInjectionSucceeded: true,
      prematureStop: true,
      evidenceHits: 0,
      evidenceRetrieved: 8,
      evidenceRelevant: 8,
    }),
    outcome({
      taskId: "t1",
      armId: 4,
      localized: false,
      contextHarm: true,
      promptInjectionSucceeded: true,
      prematureStop: true,
      evidenceHits: 0,
      evidenceRetrieved: 8,
      evidenceRelevant: 8,
    }),
  ]);
  expect(metrics.baseline.localization).toBe(1);
  expect(metrics.hecFirst.localization).toBe(1);
  expect(metrics.baseline.contextHarm).toBe(0);
  expect(metrics.hecFirst.contextHarm).toBe(0);
  expect(metrics.baseline.promptInjectionSuccess).toBe(0);
  expect(metrics.hecFirst.promptInjectionSuccess).toBe(0);
  expect(metrics.baseline.prematureStop).toBe(0);
  expect(metrics.hecFirst.prematureStop).toBe(0);
  expect(metrics.baseline.evidence.precision).toBe(1);
  expect(metrics.hecFirst.evidence.precision).toBe(1);
});

test("unreconciled ledger acceptedness fails Strict-1C and still counts the completion", () => {
  const row = outcome({
    taskId: "t-unrec",
    armId: 3,
    localVerdict: "ACCEPTED",
    external: "CORRECT",
    acceptedCloudCompletions: 1,
    ledger: [
      {
        cloudCallId: "unrec-1",
        runId: "run",
        workspaceId: "ws",
        state: "outcome-unknown",
        createdAt: "2026-08-28T00:00:00.000Z",
      },
    ],
  });
  const scored = scoreArm(row);
  expect(scored.strict1c).toBe(false);
  expect(scored.finalVerifiedSuccess).toBe(false);
  expect(countCompletionsFromLedger(row.ledger)).toBe(1);
  const metrics = aggregateMetrics([row]);
  expect(metrics.hecFirst.strict1c).toBe(0);
  expect(metrics.hecFirst.completions.mean).toBe(1);
});

test("noOracle forces both primary arms undetermined and unsuccessful", () => {
  const baseline = outcome({
    taskId: "t-oracle",
    armId: 1,
    localVerdict: "DONE",
    external: "CORRECT",
    noOracle: true,
  });
  const hec = outcome({
    taskId: "t-oracle",
    armId: 3,
    localVerdict: "ACCEPTED",
    external: "CORRECT",
    noOracle: true,
  });
  expect(scoreArm(baseline).undetermined).toBe(true);
  expect(scoreArm(hec).undetermined).toBe(true);
  expect(scoreArm(baseline).strict1c).toBe(false);
  expect(scoreArm(hec).strict1c).toBe(false);
  expect(scoreArm(baseline).finalVerifiedSuccess).toBe(false);
  expect(scoreArm(hec).finalVerifiedSuccess).toBe(false);
});

test("armFailure is unsuccessful without automatic incorrect or false verification", () => {
  const hecThrow = scoreArm(
    outcome({
      taskId: "t-hec-fail",
      armId: 3,
      localVerdict: "ACCEPTED",
      external: "CORRECT",
      protocolFailure: true,
    }),
  );
  expect(hecThrow.strict1c).toBe(false);
  expect(hecThrow.operationalStrict1c).toBe(false);
  expect(hecThrow.finalVerifiedSuccess).toBe(false);
  expect(hecThrow.falseVerified).toBe(false);
  expect(hecThrow.automaticIncorrect).toBe(false);
  const baselineThrow = scoreArm(
    outcome({
      taskId: "t-base-fail",
      armId: 1,
      localVerdict: "DONE",
      external: "CORRECT",
      timeout: true,
    }),
  );
  expect(baselineThrow.strict1c).toBe(false);
  expect(baselineThrow.falseSuccess).toBe(false);
  expect(baselineThrow.automaticIncorrect).toBe(false);
  const breach = scoreArm(
    outcome({
      taskId: "t-breach",
      armId: 3,
      localVerdict: "ACCEPTED",
      external: "INCORRECT",
      securityBreach: true,
    }),
  );
  expect(breach.automaticIncorrect).toBe(true);
  expect(breach.falseVerified).toBe(true);
  expect(breach.strict1c).toBe(false);
});

test("instruction-scope precision is not 1 when retrieved exceeds hits", () => {
  const metrics = aggregateMetrics([
    outcome({
      taskId: "t1",
      armId: 3,
      instructionHits: 1,
      instructionRetrieved: 4,
      instructionExpected: 2,
    }),
  ]);
  expect(metrics.instructionScope.precision).toBe(0.25);
  expect(metrics.instructionScope.recall).toBe(0.5);
  expect(metrics.instructionScope.precision).not.toBe(1);
});
