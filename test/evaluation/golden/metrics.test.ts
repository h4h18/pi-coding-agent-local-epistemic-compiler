import { expect, test } from "vitest";
import { aggregateGoldenMetrics, completeTrial, primaryMetric } from "./metrics.js";
import type { GoldenTrialRecord, OracleScore, TrialObservation } from "./types.js";

function score(overrides: Partial<OracleScore> = {}): OracleScore {
  return {
    taskId: "golden/node-backend/bug",
    acceptanceSuccess: true,
    scopePrecision: 1,
    regression: false,
    evidenceCoverage: 1,
    mustChangeHits: ["src/auth/session.ts"],
    mustChangeMisses: [],
    forbiddenTouched: [],
    extraTouched: [],
    requiredBehavior: [],
    forbiddenBehavior: [],
    evidenceHits: ["regression-test"],
    evidenceMisses: [],
    hiddenTestAccess: false,
    ...overrides,
  };
}

function observation(overrides: Partial<TrialObservation> = {}): TrialObservation {
  return {
    declaredDisposition: "READY",
    statesVisited: ["VERIFIED_ACCEPTED"],
    repairCount: 0,
    userInputCount: 0,
    recovered: false,
    recoveryAttempted: false,
    evidencePresent: ["regression-test"],
    cost: 1,
    latencyMs: 10,
    firstPass: true,
    ...overrides,
  };
}

function trial(overrides: Partial<GoldenTrialRecord> = {}): GoldenTrialRecord {
  const obs = overrides.observation ?? observation();
  const scored = overrides.score ?? score();
  return {
    ...completeTrial("golden/node-backend/bug", "node-backend", "bug", obs, scored),
    ...overrides,
  };
}

test("false READY is the primary headline metric", () => {
  const headline = aggregateGoldenMetrics([
    trial(),
    trial({
      falseReady: true,
      score: score({ acceptanceSuccess: false }),
      observation: observation({ declaredDisposition: "READY" }),
    }),
  ]);
  expect(primaryMetric(headline).name).toBe("falseReadyRate");
  expect(headline.falseReadyRate).toBe(0.5);
  expect(headline.falseReadyWilsonUpper).toBeGreaterThan(headline.falseReadyRate);
  expect(headline.acceptanceSuccess).toBe(0.5);
  expect(headline.falseReadyByIntent.bugfix).toBe(0.5);
});

test("repair convergence and recovery are scored only when attempted", () => {
  const none = aggregateGoldenMetrics([trial()]);
  expect(none.repairConvergence).toBe(0);
  expect(none.recoverySuccess).toBe(0);
  const repaired = aggregateGoldenMetrics([
    trial({
      observation: observation({ firstPass: false, repairCount: 1 }),
      firstPassSuccess: false,
      repairConverged: true,
    }),
  ]);
  expect(repaired.repairConvergence).toBe(1);
  const recovered = aggregateGoldenMetrics([
    trial({
      observation: observation({ recoveryAttempted: true, recovered: true }),
      recoverySuccess: true,
    }),
  ]);
  expect(recovered.recoverySuccess).toBe(1);
});
