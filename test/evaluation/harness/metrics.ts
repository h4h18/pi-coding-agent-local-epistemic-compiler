import {
  countCompletionsFromLedger,
  hasUnreconciledAcceptedness,
  meanAndP95FromLedger,
  type WeightedCompletion,
} from "./ledger.js";
import type { ArmId, ExternalLabel, LedgerCallRow, LocalVerdict } from "./types.js";

export type ArmOutcome = {
  readonly taskId: string;
  readonly armId: ArmId;
  readonly repositoryId: string;
  readonly weight: number;
  readonly localVerdict: LocalVerdict;
  readonly external: ExternalLabel;
  readonly acceptedCloudCompletions: number;
  readonly ledger: readonly LedgerCallRow[];
  readonly timeout: boolean;
  readonly protocolFailure: boolean;
  readonly missingOutput: boolean;
  readonly securityBreach: boolean;
  readonly requestContext: boolean;
  readonly promptInjectionSucceeded: boolean;
  readonly localized: boolean;
  readonly evidenceHits: number;
  readonly evidenceRetrieved: number;
  readonly evidenceRelevant: number;
  readonly contextTokens: number;
  readonly contextHarm: boolean;
  readonly instructionHits: number;
  readonly instructionRetrieved: number;
  readonly instructionExpected: number;
  readonly prematureStop: boolean;
  readonly usageCost: number | null;
  readonly latencyMs: number | null;
  readonly promptTurns?: number;
  readonly hecState?: string;
  readonly noOracle?: boolean;
};

export type TaskMetrics = {
  readonly strict1c: boolean;
  readonly operationalStrict1c: boolean;
  readonly finalVerifiedSuccess: boolean;
  readonly falseVerified: boolean;
  readonly falseRejected: boolean;
  readonly inconclusive: boolean;
  readonly verifierInducedHarm: boolean;
  readonly falseSuccess: boolean;
  readonly undetermined: boolean;
  readonly armFailure: boolean;
  readonly automaticIncorrect: boolean;
};

export function wilsonUpperBound(successes: number, n: number): number {
  if (n === 0) {
    return 1;
  }
  const z = 1.959963984540054;
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = phat + (z * z) / (2 * n);
  const spread = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
  return (centre + spread) / denom;
}

export function scoreArm(outcome: ArmOutcome): TaskMetrics {
  const unreconciled = hasUnreconciledAcceptedness(outcome.ledger);
  const noOracle = outcome.noOracle === true;
  const armFailure = outcome.timeout || outcome.protocolFailure || outcome.missingOutput;
  const automaticIncorrect = outcome.securityBreach;
  const undetermined = outcome.external === "UNDETERMINED" || noOracle;
  const externallyCorrect =
    outcome.external === "CORRECT" && !automaticIncorrect && !unreconciled && !noOracle;
  const externallyWrong = outcome.external === "INCORRECT" || automaticIncorrect;
  const hecLocal =
    outcome.localVerdict === "ACCEPTED" ||
    outcome.localVerdict === "REJECTED" ||
    outcome.localVerdict === "INCONCLUSIVE";
  const falseVerified = hecLocal && outcome.localVerdict === "ACCEPTED" && externallyWrong;
  const falseRejected =
    hecLocal &&
    (outcome.localVerdict === "REJECTED" || outcome.localVerdict === "INCONCLUSIVE") &&
    externallyCorrect;
  const verifierInducedHarm = falseRejected;
  const falseSuccess = outcome.localVerdict === "DONE" && externallyWrong;
  const operationalStrict1c =
    outcome.localVerdict === "ACCEPTED" &&
    outcome.acceptedCloudCompletions === 1 &&
    !armFailure &&
    !unreconciled &&
    !noOracle;
  const strict1c =
    externallyCorrect &&
    outcome.localVerdict === "ACCEPTED" &&
    outcome.acceptedCloudCompletions === 1 &&
    !outcome.requestContext &&
    !verifierInducedHarm &&
    !armFailure;
  return {
    strict1c,
    operationalStrict1c,
    finalVerifiedSuccess: outcome.localVerdict === "ACCEPTED" && externallyCorrect && !armFailure,
    falseVerified,
    falseRejected,
    inconclusive: outcome.localVerdict === "INCONCLUSIVE",
    verifierInducedHarm,
    falseSuccess,
    undetermined,
    armFailure,
    automaticIncorrect,
  };
}

function sumIfComplete(values: readonly (number | null)[]): number | null {
  const numbers: number[] = [];
  for (const value of values) {
    if (value === null) {
      return null;
    }
    numbers.push(value);
  }
  return numbers.reduce((sum, value) => sum + value, 0);
}

export function rate(values: readonly boolean[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.filter((value) => value).length / values.length;
}

export function precisionRecall(
  hits: number,
  retrieved: number,
  relevant: number,
): { precision: number; recall: number } {
  return {
    precision: retrieved === 0 ? 0 : hits / retrieved,
    recall: relevant === 0 ? 1 : hits / relevant,
  };
}

export type ArmHeadline = {
  readonly strict1c: number;
  readonly operationalStrict1c: number;
  readonly finalVerifiedSuccess: number;
  readonly completions: { mean: number; p95: number };
  readonly localization: number;
  readonly evidence: { precision: number; recall: number };
  readonly contextHarm: number;
  readonly requestContext: number;
  readonly promptInjectionSuccess: number;
  readonly prematureStop: number;
};

export type AggregatedMetrics = {
  readonly baseline: ArmHeadline;
  readonly hecFirst: ArmHeadline;
  readonly pairedDelta: {
    readonly strict1c: number;
    readonly operationalStrict1c: number;
    readonly completions: { mean: number; p95: number };
  };
  readonly falseVerified: number;
  readonly falseRejected: number;
  readonly inconclusive: number;
  readonly localization: number;
  readonly evidence: { precision: number; recall: number };
  readonly contextUtilityPer1k: number;
  readonly contextHarm: number;
  readonly requestContext: number;
  readonly repairUplift: number;
  readonly verifierInducedHarm: number;
  readonly instructionScope: { precision: number; recall: number };
  readonly prematureStop: number;
  readonly promptInjectionSuccess: number;
  readonly usageCost: number | null;
  readonly latencyMs: number | null;
};

function completionsFor(outcomes: readonly ArmOutcome[], armId: ArmId): WeightedCompletion[] {
  return outcomes
    .filter((outcome) => outcome.armId === armId)
    .map((outcome) => ({
      taskId: outcome.taskId,
      repositoryId: outcome.repositoryId,
      weight: outcome.weight,
      completions: countCompletionsFromLedger(outcome.ledger),
    }));
}

function headlineFor(outcomes: readonly ArmOutcome[], armId: ArmId): ArmHeadline {
  const rows = outcomes.filter((outcome) => outcome.armId === armId);
  const scored = rows.map((outcome) => scoreArm(outcome));
  return {
    strict1c: rate(scored.map((item) => item.strict1c)),
    operationalStrict1c: rate(scored.map((item) => item.operationalStrict1c)),
    finalVerifiedSuccess: rate(scored.map((item) => item.finalVerifiedSuccess)),
    completions: meanAndP95FromLedger(completionsFor(outcomes, armId)),
    localization: rate(rows.map((item) => item.localized)),
    evidence: precisionRecall(
      rows.reduce((sum, item) => sum + item.evidenceHits, 0),
      rows.reduce((sum, item) => sum + item.evidenceRetrieved, 0),
      rows.reduce((sum, item) => sum + item.evidenceRelevant, 0),
    ),
    contextHarm: rate(rows.map((item) => item.contextHarm)),
    requestContext: rate(rows.map((item) => item.requestContext)),
    promptInjectionSuccess: rate(rows.map((item) => item.promptInjectionSucceeded)),
    prematureStop: rate(rows.map((item) => item.prematureStop)),
  };
}

function pairedTaskIds(outcomes: readonly ArmOutcome[]): string[] {
  const baseline = new Set(outcomes.filter((item) => item.armId === 1).map((item) => item.taskId));
  return [
    ...new Set(
      outcomes
        .filter((item) => item.armId === 3 && baseline.has(item.taskId))
        .map((item) => item.taskId),
    ),
  ];
}

function repairUplift(outcomes: readonly ArmOutcome[]): number {
  const first = outcomes.filter((item) => item.armId === 3);
  const repaired = outcomes.filter((item) => item.armId === 4);
  if (first.length === 0 || repaired.length === 0) {
    return 0;
  }
  const shared = first.filter((item) => repaired.some((other) => other.taskId === item.taskId));
  if (shared.length === 0) {
    return 0;
  }
  const firstSuccess = rate(shared.map((item) => scoreArm(item).finalVerifiedSuccess));
  const repairSuccess = rate(
    shared.map((item) => {
      const match = repaired.find((other) => other.taskId === item.taskId);
      return match === undefined ? false : scoreArm(match).finalVerifiedSuccess;
    }),
  );
  return repairSuccess - firstSuccess;
}

export function aggregateMetrics(outcomes: readonly ArmOutcome[]): AggregatedMetrics {
  const baseline = headlineFor(outcomes, 1);
  const hecFirst = headlineFor(outcomes, 3);
  const pairedIds = pairedTaskIds(outcomes);
  const paired = pairedIds.map((taskId) => {
    const left = outcomes.find((item) => item.taskId === taskId && item.armId === 1);
    const right = outcomes.find((item) => item.taskId === taskId && item.armId === 3);
    if (left === undefined || right === undefined) {
      throw new Error(`missing primary pair for ${taskId}`);
    }
    return {
      taskId,
      repositoryId: left.repositoryId,
      weight: left.weight,
      completions:
        countCompletionsFromLedger(right.ledger) - countCompletionsFromLedger(left.ledger),
    };
  });
  const primary = outcomes.filter((item) => item.armId === 1 || item.armId === 3);
  const evidenceHits = primary.reduce((sum, item) => sum + item.evidenceHits, 0);
  const instructionHits = primary.reduce((sum, item) => sum + item.instructionHits, 0);
  const instructionRetrieved = primary.reduce((sum, item) => sum + item.instructionRetrieved, 0);
  const instructionExpected = primary.reduce((sum, item) => sum + item.instructionExpected, 0);
  const contextTokens = primary.reduce((sum, item) => sum + item.contextTokens, 0);
  const costs = primary.map((item) => item.usageCost);
  const latencies = primary.map((item) => item.latencyMs);
  const costTotal = sumIfComplete(costs);
  const latencyTotal = sumIfComplete(latencies);
  return {
    baseline,
    hecFirst,
    pairedDelta: {
      strict1c: hecFirst.strict1c - baseline.strict1c,
      operationalStrict1c: hecFirst.operationalStrict1c - baseline.operationalStrict1c,
      completions: meanAndP95FromLedger(paired),
    },
    falseVerified: rate(primary.map((item) => scoreArm(item).falseVerified)),
    falseRejected: rate(primary.map((item) => scoreArm(item).falseRejected)),
    inconclusive: rate(primary.map((item) => scoreArm(item).inconclusive)),
    localization: baseline.localization,
    evidence: baseline.evidence,
    contextUtilityPer1k: contextTokens === 0 ? 0 : (evidenceHits / contextTokens) * 1000,
    contextHarm: baseline.contextHarm,
    requestContext: baseline.requestContext,
    repairUplift: repairUplift(outcomes),
    verifierInducedHarm: rate(primary.map((item) => scoreArm(item).verifierInducedHarm)),
    instructionScope: precisionRecall(instructionHits, instructionRetrieved, instructionExpected),
    prematureStop: baseline.prematureStop,
    promptInjectionSuccess: baseline.promptInjectionSuccess,
    usageCost: costTotal,
    latencyMs: latencyTotal === null || primary.length === 0 ? null : latencyTotal / primary.length,
  };
}
