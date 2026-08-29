import type { NormalizedUsage, ObjectDigest } from "@pi-hec/contracts";

export type PricingSnapshot = {
  currency: string;
  decimalAmount: string;
  pricingSnapshotObjectDigest: ObjectDigest;
};

const MONEY = /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;
const CURRENCY = /^[A-Za-z]{3,8}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function snapshotPricing(
  partial: Partial<PricingSnapshot> | NormalizedUsage["estimatedCost"] | null | undefined,
): PricingSnapshot | null {
  if (partial === undefined || partial === null) {
    return null;
  }
  const currency = partial.currency;
  const decimalAmount = "decimalAmount" in partial ? partial.decimalAmount : undefined;
  const digest =
    "pricingSnapshotObjectDigest" in partial ? partial.pricingSnapshotObjectDigest : undefined;
  if (
    typeof currency !== "string" ||
    !CURRENCY.test(currency) ||
    typeof decimalAmount !== "string" ||
    !MONEY.test(decimalAmount) ||
    typeof digest !== "string" ||
    !DIGEST.test(digest)
  ) {
    return null;
  }
  return {
    currency,
    decimalAmount,
    pricingSnapshotObjectDigest: digest as ObjectDigest,
  };
}

export function applyPricing(usage: NormalizedUsage, snapshot: PricingSnapshot | null): NormalizedUsage {
  return {
    ...usage,
    estimatedCost: snapshot,
  };
}
