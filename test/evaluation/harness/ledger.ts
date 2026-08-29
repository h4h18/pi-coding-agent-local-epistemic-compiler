import { projectUsage, type CloudCallOutcome } from "@pi-hec/usage";
import type { LedgerCallRow } from "./types.js";

const COUNTED_STATES = new Set(["completed", "outcome-unknown"]);

export function toCloudCallOutcomes(rows: readonly LedgerCallRow[]): CloudCallOutcome[] {
  return rows.map((row) => ({
    cloudCallId: row.cloudCallId,
    runId: row.runId,
    workspaceId: row.workspaceId,
    state: row.state,
    createdAt: row.createdAt,
  }));
}

export function countCompletionsFromLedger(rows: readonly LedgerCallRow[]): number {
  const calls = toCloudCallOutcomes(rows);
  const accepted = projectUsage({
    entries: [],
    calls,
    scope: "project",
  }).acceptedCompletionCount;
  const unreconciled = calls.filter((call) => call.state === "outcome-unknown").length;
  return accepted + unreconciled;
}

export function isCountedLedgerState(state: string): boolean {
  return COUNTED_STATES.has(state);
}

export function hasUnreconciledAcceptedness(rows: readonly LedgerCallRow[]): boolean {
  return rows.some((row) => row.state === "outcome-unknown" || row.state === "accepted-outcome-unknown");
}

export type WeightedCompletion = {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly weight: number;
  readonly completions: number;
};

export function weightedMean(rows: readonly WeightedCompletion[]): number {
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight === 0) {
    return 0;
  }
  return rows.reduce((sum, row) => sum + row.weight * row.completions, 0) / totalWeight;
}

export function weightedP95(rows: readonly WeightedCompletion[]): number {
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight === 0 || rows.length === 0) {
    return 0;
  }
  const ordered = [...rows].sort((left, right) => {
    if (left.completions !== right.completions) {
      return left.completions < right.completions ? -1 : 1;
    }
    return left.taskId < right.taskId ? -1 : 1;
  });
  const threshold = 0.95 * totalWeight;
  let cumulative = 0;
  for (const row of ordered) {
    cumulative += row.weight;
    if (cumulative + Number.EPSILON >= threshold) {
      return row.completions;
    }
  }
  return ordered[ordered.length - 1]?.completions ?? 0;
}

export function meanAndP95FromLedger(rows: readonly WeightedCompletion[]): { mean: number; p95: number } {
  return {
    mean: weightedMean(rows),
    p95: weightedP95(rows),
  };
}
