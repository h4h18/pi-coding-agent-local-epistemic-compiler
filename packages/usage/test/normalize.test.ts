import { expect, test } from "vitest";
import { normalizeProviderUsage } from "../src/normalize.js";

test("missing provider fields stay null and totals are not invented", () => {
  const empty = normalizeProviderUsage(undefined);
  expect(empty.inputTokens).toBeNull();
  expect(empty.outputTokens).toBeNull();
  expect(empty.reasoningTokens).toBeNull();
  expect(empty.cachedInputTokens).toBeNull();
  expect(empty.cacheWriteTokens).toBeNull();
  expect(empty.totalTokens).toBeNull();
  expect(empty.providerReported).toBe(false);
  expect(empty.complete).toBe(false);
  expect(empty.estimatedCost).toBeNull();

  const abort = normalizeProviderUsage({
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    totalTokens: 999,
  });
  expect(abort.totalTokens).toBeNull();
  expect(abort.complete).toBe(false);
  expect(abort.providerReported).toBe(false);

  const cachedOnly = normalizeProviderUsage({ cachedInputTokens: 4 });
  expect(cachedOnly.cachedInputTokens).toBe(4);
  expect(cachedOnly.inputTokens).toBeNull();
  expect(cachedOnly.totalTokens).toBeNull();
  expect(cachedOnly.complete).toBe(false);
  expect(cachedOnly.providerReported).toBe(true);
});

test("overlapping reasoning that cannot be stripped stays incomplete", () => {
  const usage = normalizeProviderUsage({
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 20,
    reasoningIncludedInOutput: true,
  });
  expect(usage.outputTokens).toBe(5);
  expect(usage.reasoningTokens).toBe(20);
  expect(usage.totalTokens).toBeNull();
  expect(usage.complete).toBe(false);
  expect(usage.providerReported).toBe(true);
});

test("reasoning already included in provider output is not double-counted", () => {
  const usage = normalizeProviderUsage({
    inputTokens: 10,
    outputTokens: 100,
    reasoningTokens: 20,
    reasoningIncludedInOutput: true,
  });
  expect(usage.inputTokens).toBe(10);
  expect(usage.outputTokens).toBe(80);
  expect(usage.reasoningTokens).toBe(20);
  expect(usage.totalTokens).toBe(110);
  expect(usage.complete).toBe(true);
  expect(usage.providerReported).toBe(true);
});
