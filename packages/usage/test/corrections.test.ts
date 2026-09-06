import { expect, test } from "vitest";
import { normalizeProviderUsage } from "../src/normalize.js";
import { persistNormalizedUsage } from "../src/index.js";
import { loadUsageLedger, uniqueLeaves } from "../src/projections.js";
import { NOW, openTempStore, seedRunWithCall, seedUsageWorld } from "./helpers.js";

test("corrections are append-only; unique leaf wins; a second branch is rejected", () => {
  const opened = openTempStore();
  try {
    const world = seedUsageWorld(opened.store, "proj-usage-corr");
    seedRunWithCall(opened.store, world, "run_01900000-0000-7000-8000-000000002201", "call-corr");

    const first = normalizeProviderUsage({ inputTokens: 1, outputTokens: 1, reasoningTokens: 0 });
    persistNormalizedUsage(opened.store, world.projectScope, {
      usageEntryId: "usage-1",
      cloudCallId: "call-corr",
      createdAt: NOW,
      usage: first,
    });

    const correction = normalizeProviderUsage({
      inputTokens: 2,
      outputTokens: 1,
      reasoningTokens: 0,
    });
    persistNormalizedUsage(opened.store, world.projectScope, {
      usageEntryId: "usage-2",
      cloudCallId: "call-corr",
      createdAt: NOW,
      usage: correction,
      correctionOf: "usage-1",
    });

    const ledger = loadUsageLedger(opened.store, world.projectScope);
    expect(ledger.entries).toHaveLength(2);
    const leaves = uniqueLeaves(ledger.entries);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.usageEntryId).toBe("usage-2");
    expect(leaves[0]?.inputTokens).toBe(2);
    expect(leaves[0]?.normalizedTotalTokens).toBe(3);

    expect(() => {
      persistNormalizedUsage(opened.store, world.projectScope, {
        usageEntryId: "usage-3",
        cloudCallId: "call-corr",
        createdAt: NOW,
        usage: correction,
        correctionOf: "usage-1",
      });
    }).toThrow(/UNIQUE|constraint/i);
  } finally {
    opened.close();
  }
});
