import { expect, test } from "vitest";
import { shouldRetry } from "../src/index.js";

test("retries only idempotent reads", () => {
  expect(
    shouldRetry({
      operationClass: "read",
      attempt: 1,
      maxAttempts: 3,
      error: { kind: "network" },
    }),
  ).toBe(true);
  expect(
    shouldRetry({
      operationClass: "read",
      attempt: 1,
      maxAttempts: 3,
      error: { kind: "status", status: 503, retryClass: "safe" },
    }),
  ).toBe(true);
  expect(
    shouldRetry({
      operationClass: "mut-sync",
      attempt: 1,
      maxAttempts: 3,
      error: { kind: "network" },
    }),
  ).toBe(false);
  expect(
    shouldRetry({
      operationClass: "mut-run",
      attempt: 1,
      maxAttempts: 3,
      error: { kind: "status", status: 503 },
    }),
  ).toBe(false);
  expect(
    shouldRetry({
      operationClass: "content",
      attempt: 1,
      maxAttempts: 3,
      error: { kind: "network" },
    }),
  ).toBe(false);
  expect(
    shouldRetry({
      operationClass: "lease",
      attempt: 1,
      maxAttempts: 3,
      error: { kind: "network" },
    }),
  ).toBe(false);
});
