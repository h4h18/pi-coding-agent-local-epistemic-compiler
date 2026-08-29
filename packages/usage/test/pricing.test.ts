import { expect, test } from "vitest";
import type { ObjectDigest } from "@pi-hec/contracts";
import { normalizeProviderUsage } from "../src/normalize.js";
import { applyPricing, snapshotPricing } from "../src/pricing.js";

const DIGEST = `sha256:${"ab".repeat(32)}` as ObjectDigest;

test("cost is omitted unless the full pricing snapshot triple is present", () => {
  expect(snapshotPricing(undefined)).toBeNull();
  expect(snapshotPricing({ currency: "USD" })).toBeNull();
  expect(snapshotPricing({ currency: "USD", decimalAmount: "1.25" })).toBeNull();
  expect(
    snapshotPricing({
      currency: "USD",
      pricingSnapshotObjectDigest: DIGEST,
    }),
  ).toBeNull();
  expect(
    snapshotPricing({
      decimalAmount: "1.25",
      pricingSnapshotObjectDigest: DIGEST,
    }),
  ).toBeNull();

  const snapshot = snapshotPricing({
    currency: "USD",
    decimalAmount: "1.25",
    pricingSnapshotObjectDigest: DIGEST,
  });
  expect(snapshot).toEqual({
    currency: "USD",
    decimalAmount: "1.25",
    pricingSnapshotObjectDigest: DIGEST,
  });

  const bare = normalizeProviderUsage({ inputTokens: 3, outputTokens: 1 });
  expect(bare.estimatedCost).toBeNull();
  expect(applyPricing(bare, null).estimatedCost).toBeNull();
  expect(applyPricing(bare, snapshot).estimatedCost).toEqual(snapshot);
});
