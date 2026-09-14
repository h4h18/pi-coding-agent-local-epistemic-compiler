import { wilsonUpperBound } from "../harness/metrics.js";
import { primaryIntentForGoldenKind } from "./composition.js";
import { isFalseReady } from "./score.js";
import type { GoldenHeadline, GoldenTrialRecord, OracleScore, TrialObservation } from "./types.js";

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(values: readonly boolean[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.filter((value) => value).length / values.length;
}

function completeSum(values: readonly (number | null)[]): number | null {
  const numbers: number[] = [];
  for (const value of values) {
    if (value === null) {
      return null;
    }
    numbers.push(value);
  }
  return numbers.reduce((sum, value) => sum + value, 0);
}

export function completeTrial(
  taskId: string,
  repoId: GoldenTrialRecord["repoId"],
  kind: GoldenTrialRecord["kind"],
  observation: TrialObservation,
  score: OracleScore,
): GoldenTrialRecord {
  const falseReady = isFalseReady(observation, score);
  const firstPassSuccess =
    observation.firstPass &&
    observation.repairCount === 0 &&
    score.acceptanceSuccess &&
    observation.declaredDisposition === "READY";
  const repairConverged =
    observation.repairCount === 0
      ? null
      : score.acceptanceSuccess && observation.declaredDisposition === "READY";
  const recoverySuccess = observation.recoveryAttempted ? observation.recovered : null;
  return {
    taskId,
    repoId,
    kind,
    primaryIntent: primaryIntentForGoldenKind(kind),
    observation,
    score,
    falseReady,
    firstPassSuccess,
    repairConverged,
    userInterrupted:
      observation.declaredDisposition === "WAITING_FOR_USER" || observation.userInputCount > 0,
    recoverySuccess,
  };
}

export function aggregateGoldenMetrics(trials: readonly GoldenTrialRecord[]): GoldenHeadline {
  const falseReady = trials.map((item) => item.falseReady);
  const repair = trials
    .map((item) => item.repairConverged)
    .filter((item): item is boolean => item !== null);
  const recovery = trials
    .map((item) => item.recoverySuccess)
    .filter((item): item is boolean => item !== null);
  const costs = trials.map((item) => item.observation.cost);
  const latencies = trials.map((item) => item.observation.latencyMs);
  const latencyTotal = completeSum(latencies);
  const falseReadyByIntent: Record<string, number> = {};
  const intentCounts: Record<string, number> = {};
  for (const item of trials) {
    const intent = item.primaryIntent;
    intentCounts[intent] = (intentCounts[intent] ?? 0) + 1;
    if (item.falseReady) {
      falseReadyByIntent[intent] = (falseReadyByIntent[intent] ?? 0) + 1;
    }
  }
  const falseReadyRates: Record<string, number> = {};
  for (const [intent, count] of Object.entries(intentCounts)) {
    falseReadyRates[intent] = (falseReadyByIntent[intent] ?? 0) / count;
  }
  return {
    trialCount: trials.length,
    acceptanceSuccess: rate(trials.map((item) => item.score.acceptanceSuccess)),
    falseReadyRate: rate(falseReady),
    falseReadyWilsonUpper: wilsonUpperBound(
      falseReady.filter((item) => item).length,
      falseReady.length,
    ),
    scopePrecision: mean(trials.map((item) => item.score.scopePrecision)),
    regressionRate: rate(trials.map((item) => item.score.regression)),
    firstPassSuccess: rate(trials.map((item) => item.firstPassSuccess)),
    repairConvergence: rate(repair),
    evidenceCoverage: mean(trials.map((item) => item.score.evidenceCoverage)),
    userInterruptionRate: rate(trials.map((item) => item.userInterrupted)),
    recoverySuccess: rate(recovery),
    cost: completeSum(costs),
    latencyMs: latencyTotal === null || trials.length === 0 ? null : latencyTotal / trials.length,
    falseReadyByIntent: falseReadyRates,
  };
}

export function primaryMetric(headline: GoldenHeadline): {
  readonly name: "falseReadyRate";
  readonly value: number;
  readonly wilsonUpper: number;
} {
  return {
    name: "falseReadyRate",
    value: headline.falseReadyRate,
    wilsonUpper: headline.falseReadyWilsonUpper,
  };
}
