import type { NormalizedUsage, ObjectDigest } from "@pi-hec/contracts";
import type { UsageInput } from "@pi-hec/state-store";
import { applyPricing, snapshotPricing } from "./pricing.js";

export type ProviderUsageDraft = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalTokens?: number | null;
  estimatedCost?: NormalizedUsage["estimatedCost"];
  reasoningIncludedInOutput?: boolean;
};

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  totalTokens: null,
  providerReported: false,
  complete: false,
  estimatedCost: null,
};

function presentNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function fieldOrNull(value: number | null | undefined): number | null {
  return presentNumber(value) ? value : null;
}

export function normalizeProviderUsage(draft?: ProviderUsageDraft | null): NormalizedUsage {
  if (draft === undefined || draft === null) {
    return EMPTY_USAGE;
  }

  const inputTokens = fieldOrNull(draft.inputTokens);
  let outputTokens = fieldOrNull(draft.outputTokens);
  const reasoningTokens = fieldOrNull(draft.reasoningTokens);
  let cachedInputTokens = fieldOrNull(draft.cachedInputTokens);
  const cacheWriteTokens = fieldOrNull(draft.cacheWriteTokens);

  const providerReported =
    presentNumber(draft.inputTokens) ||
    presentNumber(draft.outputTokens) ||
    presentNumber(draft.reasoningTokens) ||
    presentNumber(draft.cachedInputTokens) ||
    presentNumber(draft.cacheWriteTokens);

  const overlappingReasoning =
    draft.reasoningIncludedInOutput === true &&
    outputTokens !== null &&
    reasoningTokens !== null &&
    outputTokens < reasoningTokens;

  if (
    draft.reasoningIncludedInOutput === true &&
    outputTokens !== null &&
    reasoningTokens !== null &&
    outputTokens >= reasoningTokens
  ) {
    outputTokens = outputTokens - reasoningTokens;
  }

  if (cachedInputTokens !== null && inputTokens !== null && cachedInputTokens > inputTokens) {
    cachedInputTokens = null;
  }

  const unitPresent = inputTokens !== null || outputTokens !== null || reasoningTokens !== null;
  const totalTokens =
    unitPresent && !overlappingReasoning
      ? (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0)
      : null;

  return applyPricing(
    {
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedInputTokens,
      cacheWriteTokens,
      totalTokens,
      providerReported,
      complete: unitPresent && totalTokens !== null && !overlappingReasoning,
      estimatedCost: null,
    },
    snapshotPricing(draft.estimatedCost),
  );
}

export function toUsageInput(input: {
  usageEntryId: string;
  cloudCallId: string;
  createdAt: string;
  usage: NormalizedUsage;
  correctionOf?: string;
}): UsageInput {
  const cost = input.usage.estimatedCost;
  const row: UsageInput = {
    usageEntryId: input.usageEntryId,
    cloudCallId: input.cloudCallId,
    createdAt: input.createdAt,
    providerReported: input.usage.providerReported,
    complete: input.usage.complete,
  };
  if (input.usage.inputTokens !== null) {
    row.inputTokens = input.usage.inputTokens;
  }
  if (input.usage.outputTokens !== null) {
    row.outputTokens = input.usage.outputTokens;
  }
  if (input.usage.reasoningTokens !== null) {
    row.reasoningTokens = input.usage.reasoningTokens;
  }
  if (input.usage.cachedInputTokens !== null) {
    row.cachedInputTokens = input.usage.cachedInputTokens;
  }
  if (input.usage.cacheWriteTokens !== null) {
    row.cacheWriteTokens = input.usage.cacheWriteTokens;
  }
  if (input.usage.totalTokens !== null && input.usage.complete) {
    row.normalizedTotalTokens = input.usage.totalTokens;
  }
  if (cost !== null) {
    row.currency = cost.currency;
    row.estimatedCostDecimal = cost.decimalAmount;
    row.pricingSnapshotDigest = cost.pricingSnapshotObjectDigest as ObjectDigest;
  }
  if (input.correctionOf !== undefined) {
    row.correctionOf = input.correctionOf;
  }
  return row;
}
