import type { RetrievalAction } from "@pi-hec/contracts";

export type PriorityContext = {
  requirementCriticality: number;
  sourceIndependence: number;
  channelPulls: number;
  totalPulls: number;
  indexCost: number;
};

export function upperConfidenceBound(
  expectedDeltaStrictPassAt1: number,
  armPulls: number,
  totalPulls: number,
): number {
  if (armPulls <= 0) {
    return expectedDeltaStrictPassAt1 + Math.sqrt(2 * Math.log(Math.max(totalPulls, 1)));
  }
  return expectedDeltaStrictPassAt1 + Math.sqrt((2 * Math.log(Math.max(totalPulls, 1))) / armPulls);
}

export function actionPriority(action: RetrievalAction, context: PriorityContext): number {
  const ucb = upperConfidenceBound(
    action.expectedInformationGain,
    context.channelPulls,
    context.totalPulls,
  );
  const cost = action.estimatedLatencyMs + context.indexCost + action.estimatedPacketTokens;
  const denominator = cost <= 0 ? 1 : cost;
  return (
    (ucb * context.requirementCriticality * context.sourceIndependence * action.expectedTrustGain) /
    denominator
  );
}

export function dominates(left: RetrievalAction, right: RetrievalAction): boolean {
  const betterOrEqualInfo = left.expectedInformationGain >= right.expectedInformationGain;
  const betterOrEqualTrust = left.expectedTrustGain >= right.expectedTrustGain;
  const betterOrEqualLatency = left.estimatedLatencyMs <= right.estimatedLatencyMs;
  const strictlyBetter =
    left.expectedInformationGain > right.expectedInformationGain ||
    left.expectedTrustGain > right.expectedTrustGain ||
    left.estimatedLatencyMs < right.estimatedLatencyMs;
  return betterOrEqualInfo && betterOrEqualTrust && betterOrEqualLatency && strictlyBetter;
}

export function paretoFrontier(actions: readonly RetrievalAction[]): RetrievalAction[] {
  return actions.filter(
    (candidate) =>
      !actions.some((other) => other.id !== candidate.id && dominates(other, candidate)),
  );
}
