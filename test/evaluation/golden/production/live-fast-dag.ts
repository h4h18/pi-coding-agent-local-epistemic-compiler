import type { RunState } from "@pi-hec/contracts";
import { architecturalDisposition } from "../disposition.js";

export const DEFAULT_LIVE_FAST_DAG_TIMEOUT_MS = 8 * 15 * 60 * 1000 + 120_000;
export const DEFAULT_LIVE_FAST_DAG_POLL_MS = 2_000;

export function liveFastDagTimeoutMs(): number {
  const raw = process.env.PI_HEC_LIVE_DAG_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_LIVE_FAST_DAG_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("PI_HEC_LIVE_DAG_TIMEOUT_MS must be a positive number");
  }
  return parsed;
}

export function liveFastDagStillRunning(state: RunState): boolean {
  return architecturalDisposition(state) === "RUNNING";
}

export function liveFastDagReachedOutcome(state: RunState): boolean {
  const disposition = architecturalDisposition(state);
  switch (disposition) {
    case "READY":
    case "FAILED":
    case "BLOCKED":
      return true;
    case "RUNNING":
    case "WAITING_FOR_USER":
      return false;
    default: {
      const exhaustive: never = disposition;
      return exhaustive;
    }
  }
}
