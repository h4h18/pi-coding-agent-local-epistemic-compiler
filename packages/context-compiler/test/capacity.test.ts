import { expect, test } from "vitest";
import type { ObjectDigest } from "@pi-hec/contracts";
import { compileCloudContext } from "../src/index.js";
import { SOURCE_BODY, compilerInput, deployment } from "./fixtures.js";

test("mandatory overflow returns WAITING_INITIAL_CONTEXT_CAPACITY instead of truncating the ledger", () => {
  const input = compilerInput({
    deployment: deployment({ contextLimitTokens: 64, maxOutputTokens: 64_000 }),
  });
  const outcome = compileCloudContext(input);
  expect(outcome.kind).toBe("waiting");
  if (outcome.kind !== "waiting") {
    return;
  }
  expect(outcome.state).toBe("WAITING_INITIAL_CONTEXT_CAPACITY");
  expect(outcome).not.toHaveProperty("artifacts");
});

test("output reserve above maxOutputTokens returns WAITING_INITIAL_OUTPUT_CAPACITY", () => {
  const input = compilerInput({
    deployment: deployment({ contextLimitTokens: 128_000, maxOutputTokens: 16 }),
    historicalOutputTokens: [40_000],
  });
  const outcome = compileCloudContext(input);
  expect(outcome.kind).toBe("waiting");
  if (outcome.kind !== "waiting") {
    return;
  }
  expect(outcome.state).toBe("WAITING_INITIAL_OUTPUT_CAPACITY");
});

test("repair purpose names WAITING_REPAIR_CONTEXT_CAPACITY", () => {
  const input = compilerInput({
    purpose: "repair",
    parentCloudCallId: "call_01234567-89ab-7cde-8f01-23456789abcd",
    repairPacketObjectDigest: ("sha256:" + "11".repeat(32)) as ObjectDigest,
    priorCandidateManifestObjectDigest: ("sha256:" + "22".repeat(32)) as ObjectDigest,
    deployment: deployment({ contextLimitTokens: 64, maxOutputTokens: 64_000 }),
  });
  const outcome = compileCloudContext(input);
  expect(outcome.kind).toBe("waiting");
  if (outcome.kind !== "waiting") {
    return;
  }
  expect(outcome.state).toBe("WAITING_REPAIR_CONTEXT_CAPACITY");
});

test("successful compile keeps the full requirement ledger including non-goals", () => {
  const outcome = compileCloudContext(compilerInput());
  expect(outcome.kind).toBe("compiled");
  if (outcome.kind !== "compiled") {
    return;
  }
  expect(outcome.artifacts.packet.requirementLedger.nonGoals).toHaveLength(1);
  expect(outcome.artifacts.packet.requirementLedger.originalRequest.length).toBeGreaterThan(10);
  expect(outcome.artifacts.packet.bundles.some((bundle) => bundle.purpose === "requirement-witness")).toBe(true);
  expect(SOURCE_BODY.length).toBeGreaterThan(0);
});
