import { Compile } from "typebox/compile";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { DeploymentCapabilitiesSchema, sha256Hex } from "@pi-hec/contracts";
import { loadCloudCapabilityRecords, validateCloudCapabilityRecord } from "./cloud-capabilities.js";
import { repoRoot } from "./profiles.js";

const validator = Compile(DeploymentCapabilitiesSchema);
const modelsDir = path.join(repoRoot(), "config", "models");

function digestOf(bytes: Buffer): string {
  return sha256Hex(bytes);
}

test("committed cloud records validate DeploymentCapabilitiesSchema and extra properties are rejected", async () => {
  const records = await loadCloudCapabilityRecords(modelsDir);
  expect(records.length).toBeGreaterThanOrEqual(2);
  for (const record of records) {
    expect(validator.Check(record.capabilities)).toBe(true);
    expect(validator.Check({ ...record.capabilities, extra: true })).toBe(false);
  }
});

test("OpenAI-shaped HTTP is not enough to mark tools or structuredOutput native", async () => {
  const records = await loadCloudCapabilityRecords(modelsDir);
  const openaiShaped = records.find((record) => record.capabilities.deploymentId === "openai-shaped-unknown");
  expect(openaiShaped).toBeDefined();
  expect(openaiShaped?.capabilities.tools.supported).toBe("unknown");
  expect(openaiShaped?.capabilities.structuredOutput.jsonSchema).toBe("unknown");
  expect(openaiShaped?.capabilities.recovery.grade).toBe("C");
});

test("conformanceResultObjectDigest is the sha256 of the raw fixture bytes", async () => {
  const records = await loadCloudCapabilityRecords(modelsDir);
  expect(records.length).toBeGreaterThanOrEqual(2);
  for (const record of records) {
    const evidence = record.capabilities.evidence[0];
    expect(evidence).toBeDefined();
    if (evidence === undefined) {
      continue;
    }
    const fixturePath = path.join(repoRoot(), record.rawFixtureRelativePath);
    const bytes = await readFile(fixturePath);
    expect(evidence.conformanceResultObjectDigest).toBe(digestOf(bytes));
  }
});

test("Grade A without lookup proof is rejected by the fixture loader", () => {
  const capabilities = {
    deploymentId: "grade-a-without-proof",
    adapterVersionObjectDigest: "sha256:" + "ab".repeat(32),
    providerApiVersion: "2024-06-01",
    modelRevision: "fake-1",
    context: { nativeTokens: 128000, extendedTokens: null, maxOutputTokens: 4096 },
    thinking: {
      supported: "unknown",
      required: false,
      efforts: [],
      preservesAcrossToolTurns: false,
    },
    structuredOutput: { jsonSchema: "unknown", strict: "unknown", schemaDialect: null },
    tools: {
      supported: "unknown",
      requiredChoice: "unknown",
      parallelCallsCanBeDisabled: false,
      namedChoiceWithThinking: "unknown",
    },
    caching: { mode: "none", reportsReadTokens: false, reportsWriteTokens: false },
    recovery: {
      grade: "A",
      idempotencyKey: true,
      resultLookup: true,
      lookupKeyKinds: ["request-object"],
      serverCancellation: false,
    },
    evidence: [
      {
        source: "synthetic",
        checkedAt: "2026-08-28T08:45:00.000Z",
        adapterVersion: "test-1",
        conformanceResultObjectDigest: "sha256:" + "ab".repeat(32),
      },
    ],
  };
  const result = validateCloudCapabilityRecord({
    capabilities,
    transcript: { lookupByRequestIdentityCannotCreateCompletion: false },
    rawFixtureBytes: Buffer.from("{}", "utf8"),
  });
  expect(result.ok).toBe(false);
});

test("Grade A with empty lookupKeyKinds is schema-invalid", () => {
  const capabilities = {
    deploymentId: "grade-a-empty-keys",
    adapterVersionObjectDigest: "sha256:" + "ab".repeat(32),
    providerApiVersion: "v1",
    modelRevision: "m1",
    context: { nativeTokens: 1, extendedTokens: null, maxOutputTokens: null },
    thinking: {
      supported: "unknown",
      required: false,
      efforts: [],
      preservesAcrossToolTurns: false,
    },
    structuredOutput: { jsonSchema: "unknown", strict: "unknown", schemaDialect: null },
    tools: {
      supported: "unknown",
      requiredChoice: "unknown",
      parallelCallsCanBeDisabled: false,
      namedChoiceWithThinking: "unknown",
    },
    caching: { mode: "none", reportsReadTokens: false, reportsWriteTokens: false },
    recovery: {
      grade: "A",
      idempotencyKey: true,
      resultLookup: true,
      lookupKeyKinds: [],
      serverCancellation: false,
    },
    evidence: [],
  };
  expect(validator.Check(capabilities)).toBe(false);
});

test("Grade C with idempotencyKey true is schema-invalid", () => {
  const capabilities = {
    deploymentId: "grade-c-idempotent",
    adapterVersionObjectDigest: "sha256:" + "ab".repeat(32),
    providerApiVersion: "v1",
    modelRevision: "m1",
    context: { nativeTokens: 1, extendedTokens: null, maxOutputTokens: null },
    thinking: {
      supported: "unknown",
      required: false,
      efforts: [],
      preservesAcrossToolTurns: false,
    },
    structuredOutput: { jsonSchema: "unknown", strict: "unknown", schemaDialect: null },
    tools: {
      supported: "unknown",
      requiredChoice: "unknown",
      parallelCallsCanBeDisabled: false,
      namedChoiceWithThinking: "unknown",
    },
    caching: { mode: "none", reportsReadTokens: false, reportsWriteTokens: false },
    recovery: {
      grade: "C",
      idempotencyKey: true,
      resultLookup: false,
      lookupKeyKinds: [],
      serverCancellation: false,
    },
    evidence: [],
  };
  expect(validator.Check(capabilities)).toBe(false);
});
