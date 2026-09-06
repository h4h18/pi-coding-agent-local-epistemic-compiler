import { expect, test } from "vitest";
import {
  emptyUsageProjection,
  formatUsageLines,
  loadUsageLedger,
  projectUsage,
  uniqueLeaves,
} from "../src/projections.js";
import { applyPricing } from "../src/pricing.js";
import { normalizeProviderUsage, persistNormalizedUsage } from "../src/index.js";
import {
  DAY,
  NOW,
  openTempStore,
  putPricingSnapshot,
  RUN_A,
  RUN_B,
  seedRunWithCall,
  seedUsageWorld,
} from "./helpers.js";

test("empty scope rollup leaves every token field null", () => {
  const empty = projectUsage({
    entries: [],
    calls: [],
    scope: "run",
    runId: RUN_A,
  });
  expect(empty.inputTokens).toBeNull();
  expect(empty.outputTokens).toBeNull();
  expect(empty.reasoningTokens).toBeNull();
  expect(empty.cachedInputTokens).toBeNull();
  expect(empty.cacheWriteTokens).toBeNull();
  expect(empty.totalTokens).toBeNull();
  expect(empty).toEqual(emptyUsageProjection("run"));
});

test("run session day and project projections match stored leaves and UI strings", () => {
  const opened = openTempStore();
  try {
    const world = seedUsageWorld(opened.store, "proj-usage-roll");
    seedRunWithCall(opened.store, world, RUN_A, "call-a");
    seedRunWithCall(opened.store, world, RUN_B, "call-b", "prepared");

    persistNormalizedUsage(opened.store, world.projectScope, {
      usageEntryId: "usage-a1",
      cloudCallId: "call-a",
      createdAt: NOW,
      usage: normalizeProviderUsage({ inputTokens: 10, outputTokens: 4, reasoningTokens: 2 }),
    });
    persistNormalizedUsage(opened.store, world.projectScope, {
      usageEntryId: "usage-a2",
      cloudCallId: "call-a",
      createdAt: NOW,
      usage: normalizeProviderUsage({ inputTokens: 12, outputTokens: 5, reasoningTokens: 1 }),
      correctionOf: "usage-a1",
    });
    persistNormalizedUsage(opened.store, world.projectScope, {
      usageEntryId: "usage-b1",
      cloudCallId: "call-b",
      createdAt: NOW,
      usage: normalizeProviderUsage({ cachedInputTokens: 8 }),
    });

    const ledger = loadUsageLedger(opened.store, world.projectScope);
    const leaves = uniqueLeaves(ledger.entries);
    expect(leaves.map((row) => row.usageEntryId).sort()).toEqual(["usage-a2", "usage-b1"]);

    const run = projectUsage({
      entries: ledger.entries,
      calls: ledger.calls,
      scope: "run",
      runId: RUN_A,
    });
    expect(run.leafCount).toBe(1);
    expect(run.inputTokens).toBe(12);
    expect(run.outputTokens).toBe(5);
    expect(run.reasoningTokens).toBe(1);
    expect(run.totalTokens).toBe(18);
    expect(run.complete).toBe(true);
    expect(run.acceptedCompletionCount).toBe(1);
    expect(run.incompleteCount).toBe(0);

    const session = projectUsage({
      entries: ledger.entries,
      calls: ledger.calls,
      scope: "session",
      workspaceId: world.workspaceId,
    });
    expect(session.leafCount).toBe(2);
    expect(session.complete).toBe(false);
    expect(session.totalTokens).toBeNull();
    expect(session.inputTokens).toBeNull();
    expect(session.incompleteCount).toBe(1);
    expect(session.acceptedCompletionCount).toBe(1);

    const day = projectUsage({
      entries: ledger.entries,
      calls: ledger.calls,
      scope: "day",
      day: DAY,
    });
    expect(day.leafCount).toBe(2);
    expect(day.complete).toBe(false);

    const project = projectUsage({
      entries: ledger.entries,
      calls: ledger.calls,
      scope: "project",
      projectId: world.projectId,
    });
    expect(project.leafCount).toBe(2);
    expect(project.acceptedCompletionCount).toBe(1);

    const lines = formatUsageLines({
      scope: "run",
      runId: RUN_A,
      state: "SNAPSHOT_REQUESTED",
      projection: run,
    });
    expect(lines).toContain(`HEC usage (run)`);
    expect(lines).toContain(`run: ${RUN_A}`);
    expect(lines).toContain("state: SNAPSHOT_REQUESTED");
    expect(lines).toContain("input: 12");
    expect(lines).toContain("output: 5");
    expect(lines).toContain("reasoning: 1");
    expect(lines).toContain("total: 18");
    expect(lines).toContain("accepted completions: 1");
    expect(lines).toContain("Totals are informational and do not affect routing.");
  } finally {
    opened.close();
  }
});

test("pricing snapshot is required before a cost triple is stored", () => {
  const opened = openTempStore();
  try {
    const world = seedUsageWorld(opened.store, "proj-usage-price");
    seedRunWithCall(opened.store, world, RUN_A, "call-price");
    const digest = putPricingSnapshot(opened.store, world, "snap-1");
    const priced = applyPricing(normalizeProviderUsage({ inputTokens: 2, outputTokens: 2 }), {
      currency: "USD",
      decimalAmount: "0.40",
      pricingSnapshotObjectDigest: digest,
    });
    persistNormalizedUsage(opened.store, world.projectScope, {
      usageEntryId: "usage-price",
      cloudCallId: "call-price",
      createdAt: NOW,
      usage: priced,
    });
    const ledger = loadUsageLedger(opened.store, world.projectScope);
    const leaf = uniqueLeaves(ledger.entries)[0];
    expect(leaf?.currency).toBe("USD");
    expect(leaf?.estimatedCostDecimal).toBe("0.40");
    expect(leaf?.pricingSnapshotDigest).toBe(digest);
    const rollup = projectUsage({
      entries: ledger.entries,
      calls: ledger.calls,
      scope: "run",
      runId: RUN_A,
    });
    expect(rollup.currency).toBe("USD");
    expect(rollup.estimatedCostDecimal).toBe("0.40");
  } finally {
    opened.close();
  }
});
