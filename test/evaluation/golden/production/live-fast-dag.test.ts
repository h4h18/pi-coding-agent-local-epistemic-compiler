import { expect, test } from "vitest";
import {
  DEFAULT_LIVE_FAST_DAG_TIMEOUT_MS,
  liveFastDagReachedOutcome,
  liveFastDagStillRunning,
  liveFastDagTimeoutMs,
} from "./live-fast-dag.js";

test("live FAST DAG keeps waiting through snapshot, preflight, and PROFILE_RUNNING", () => {
  expect(liveFastDagStillRunning("CREATED")).toBe(true);
  expect(liveFastDagStillRunning("SNAPSHOT_REQUESTED")).toBe(true);
  expect(liveFastDagStillRunning("PREFLIGHT_COMPLETE")).toBe(true);
  expect(liveFastDagStillRunning("CONTRACTED")).toBe(true);
  expect(liveFastDagStillRunning("PROFILE_SELECTED")).toBe(true);
  expect(liveFastDagStillRunning("PROFILE_RUNNING")).toBe(true);
  expect(liveFastDagStillRunning("ACCEPTANCE_CHECK")).toBe(true);
  expect(liveFastDagReachedOutcome("PREFLIGHT_COMPLETE")).toBe(false);
  expect(liveFastDagReachedOutcome("PROFILE_RUNNING")).toBe(false);
});

test("live FAST DAG outcome is compiler READY, BLOCKED, or FAILED after the worker stretch", () => {
  expect(liveFastDagStillRunning("VERIFIED_ACCEPTED")).toBe(false);
  expect(liveFastDagStillRunning("SUCCEEDED")).toBe(false);
  expect(liveFastDagStillRunning("VERIFIED_REJECTED")).toBe(false);
  expect(liveFastDagStillRunning("FAILED")).toBe(false);
  expect(liveFastDagStillRunning("AWAITING_REQUIREMENTS_INPUT")).toBe(false);
  expect(liveFastDagReachedOutcome("VERIFIED_ACCEPTED")).toBe(true);
  expect(liveFastDagReachedOutcome("SUCCEEDED")).toBe(true);
  expect(liveFastDagReachedOutcome("VERIFIED_REJECTED")).toBe(true);
  expect(liveFastDagReachedOutcome("FAILED")).toBe(true);
  expect(liveFastDagReachedOutcome("AWAITING_REQUIREMENTS_INPUT")).toBe(false);
});

test("PI_HEC_LIVE_DAG_TIMEOUT_MS overrides the default live FAST DAG wait", () => {
  const previous = process.env.PI_HEC_LIVE_DAG_TIMEOUT_MS;
  try {
    delete process.env.PI_HEC_LIVE_DAG_TIMEOUT_MS;
    expect(liveFastDagTimeoutMs()).toBe(DEFAULT_LIVE_FAST_DAG_TIMEOUT_MS);
    process.env.PI_HEC_LIVE_DAG_TIMEOUT_MS = "1234";
    expect(liveFastDagTimeoutMs()).toBe(1234);
    process.env.PI_HEC_LIVE_DAG_TIMEOUT_MS = "0";
    expect(() => liveFastDagTimeoutMs()).toThrow(/positive number/);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_HEC_LIVE_DAG_TIMEOUT_MS;
    } else {
      process.env.PI_HEC_LIVE_DAG_TIMEOUT_MS = previous;
    }
  }
});
