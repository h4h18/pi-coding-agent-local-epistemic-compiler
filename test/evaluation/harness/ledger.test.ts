import { expect, test } from "vitest";
import { projectUsage } from "@pi-hec/usage";
import { countCompletionsFromLedger, meanAndP95FromLedger, toCloudCallOutcomes } from "./ledger.js";
import type { LedgerCallRow } from "./types.js";

const SUCCESS_THEN_REPAIR: readonly LedgerCallRow[] = [
  {
    cloudCallId: "initial",
    runId: "run_a",
    workspaceId: "ws",
    state: "completed",
    createdAt: "2026-08-28T00:00:00.000Z",
  },
  {
    cloudCallId: "follow-up",
    runId: "run_a",
    workspaceId: "ws",
    state: "completed",
    createdAt: "2026-08-28T00:01:00.000Z",
  },
  {
    cloudCallId: "failed-repair",
    runId: "run_a",
    workspaceId: "ws",
    state: "completed",
    createdAt: "2026-08-28T00:02:00.000Z",
  },
  {
    cloudCallId: "unreconciled",
    runId: "run_a",
    workspaceId: "ws",
    state: "outcome-unknown",
    createdAt: "2026-08-28T00:03:00.000Z",
  },
  {
    cloudCallId: "never-accepted",
    runId: "run_a",
    workspaceId: "ws",
    state: "prepared",
    createdAt: "2026-08-28T00:04:00.000Z",
  },
];

test("mean and p95 cloud completions come from raw ledger rows not a success-truncated counter", () => {
  const calls = toCloudCallOutcomes(SUCCESS_THEN_REPAIR);
  const accepted = projectUsage({ entries: [], calls, scope: "project" }).acceptedCompletionCount;
  expect(accepted).toBe(3);
  const raw = countCompletionsFromLedger(SUCCESS_THEN_REPAIR);
  expect(raw).toBe(4);
  expect(raw).not.toBe(1);
  const stats = meanAndP95FromLedger([
    { taskId: "heavy", repositoryId: "r1", weight: 0.2, completions: raw },
    { taskId: "mid", repositoryId: "r2", weight: 0.3, completions: 2 },
    { taskId: "light", repositoryId: "r3", weight: 0.5, completions: 1 },
  ]);
  expect(stats.mean).toBeCloseTo(0.2 * 4 + 0.3 * 2 + 0.5 * 1);
  expect(stats.p95).toBe(4);
});
