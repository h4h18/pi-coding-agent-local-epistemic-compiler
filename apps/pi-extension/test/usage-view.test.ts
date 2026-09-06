import { expect, test } from "vitest";
import { emptyUsageProjection, projectUsage, type UsageProjection } from "@pi-hec/usage";
import { parseUsageScope, renderUsageView } from "../src/ui/usage-view.js";
import { FakePi, RecordingBroker, RUN_ID, sampleRun } from "./harness.js";

const MATCHING: UsageProjection = {
  scope: "run",
  leafCount: 1,
  incompleteCount: 0,
  inputTokens: 12,
  outputTokens: 5,
  reasoningTokens: 1,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 18,
  complete: true,
  estimatedCostDecimal: null,
  currency: null,
  acceptedCompletionCount: 1,
};

test("usage view strings match stored-leaf projection numbers", () => {
  const run = sampleRun({ state: "SNAPSHOT_REQUESTED" });
  const lines = renderUsageView({ scope: "run", run, projection: MATCHING });
  expect(lines).toContain("HEC usage (run)");
  expect(lines).toContain(`run: ${RUN_ID}`);
  expect(lines).toContain("state: SNAPSHOT_REQUESTED");
  expect(lines).toContain("input: 12");
  expect(lines).toContain("output: 5");
  expect(lines).toContain("reasoning: 1");
  expect(lines).toContain("total: 18");
  expect(lines).toContain("accepted completions: 1");
  expect(lines).toContain("Totals are informational and do not affect routing.");
});

test("injected usage projection matches one accepted-completion leaf", () => {
  const projection = projectUsage({
    entries: [
      {
        usageEntryId: "usage-leaf-1",
        cloudCallId: "call_01234567-89ab-7cde-8f01-23456789abcd",
        runId: RUN_ID,
        workspaceId: "ws1",
        projectId: "proj1",
        createdAt: "2026-01-02T03:04:05.006Z",
        correctionOf: undefined,
        inputTokens: 12,
        outputTokens: 5,
        reasoningTokens: 1,
        cachedInputTokens: null,
        cacheWriteTokens: null,
        normalizedTotalTokens: 18,
        providerReported: true,
        complete: true,
        currency: null,
        estimatedCostDecimal: null,
        pricingSnapshotDigest: null,
      },
    ],
    calls: [
      {
        cloudCallId: "call_01234567-89ab-7cde-8f01-23456789abcd",
        runId: RUN_ID,
        workspaceId: "ws1",
        state: "completed",
        createdAt: "2026-01-02T03:04:05.006Z",
      },
    ],
    scope: "run",
    runId: RUN_ID,
  });
  const lines = renderUsageView({
    scope: "run",
    run: sampleRun({ state: "SNAPSHOT_REQUESTED" }),
    projection,
  });
  expect(projection.leafCount).toBe(1);
  expect(projection.acceptedCompletionCount).toBe(1);
  expect(lines).toContain("input: 12");
  expect(lines).toContain("output: 5");
  expect(lines).toContain("total: 18");
  expect(lines).toContain("accepted completions: 1");
});

test("usage command renders injected projection and opens EXPORT", async () => {
  const broker = new RecordingBroker(sampleRun({ state: "SNAPSHOT_REQUESTED" }));
  const pi = new FakePi();
  pi.install(broker, {
    securityMode: "compatibility",
    usageProjection: () => MATCHING,
  });
  await pi.runCommand(`usage ${RUN_ID}`);
  expect(pi.notifications).toContain("input: 12");
  expect(pi.notifications).toContain("total: 18");
  expect(broker.methods()).toContain("OPEN_TRUSTED_VIEW");
  expect(
    broker.calls.some(
      (call) => call.method === "OPEN_TRUSTED_VIEW" && call.params.view === "EXPORT",
    ),
  ).toBe(true);
});

test("parseUsageScope accepts run session day project", () => {
  expect(parseUsageScope(undefined)).toBe("run");
  expect(parseUsageScope("session")).toBe("session");
  expect(parseUsageScope("day")).toBe("day");
  expect(parseUsageScope("project")).toBe("project");
  const empty = emptyUsageProjection("project");
  expect(empty.complete).toBe(false);
  expect(empty.totalTokens).toBeNull();
});
