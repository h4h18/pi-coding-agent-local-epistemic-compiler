import { expect, test } from "vitest";
import { QUALITY_FLOORS } from "./quality-floors.js";
import { selectLocalDeployments, type LocalModelProfile } from "./selection.js";

function measuredProfile(overrides: Partial<LocalModelProfile> = {}): LocalModelProfile {
  return {
    kind: "local-model-profile",
    schemaVersion: 1,
    profileId: "candidate-a",
    huggingfaceId: "Qwen/Qwen3.6-27B",
    runtimeId: "vllm-rocm-linux",
    role: "local-llm",
    qualificationStatus: "measured",
    selected: false,
    weightPin: "sha256:" + "ab".repeat(32),
    advertisedNativeTokens: 262144,
    advertisedExtendedTokens: 1010000,
    measuredContextTokens: 8192,
    parameterCount: 27_000_000_000,
    metrics: {
      retrievalQueryRecall: QUALITY_FLOORS.retrievalQueryRecall,
      rerankNdcg: QUALITY_FLOORS.rerankNdcg,
      rerankMrr: QUALITY_FLOORS.rerankMrr,
      citationPrecision: QUALITY_FLOORS.citationPrecision,
      contradictionUnknownRecall: QUALITY_FLOORS.contradictionUnknownRecall,
      semanticFindingPrecision: QUALITY_FLOORS.semanticFindingPrecision,
      jsonSchemaReliability: QUALITY_FLOORS.jsonSchemaReliability,
      roleIsolation: QUALITY_FLOORS.roleIsolation,
      longContextAccuracy: QUALITY_FLOORS.longContextAccuracy,
    },
    peakUnifiedMemoryBytes: 40_000_000_000,
    p50LatencyMs: 120,
    p95LatencyMs: 400,
    evidence: [
      {
        source: "test://measured",
        checkedAt: "2026-08-28T08:45:00.000Z",
        artifactSha256: "sha256:" + "cd".repeat(32),
      },
    ],
    unqualifiedReason: null,
    adapterSurface: {
      implementsCloudCompletion: false,
      exposesRepositoryTools: false,
    },
    ...overrides,
  };
}

test("selects nothing when every required metric is missing", () => {
  const profile = measuredProfile({
    qualificationStatus: "unqualified",
    metrics: {
      retrievalQueryRecall: null,
      rerankNdcg: null,
      rerankMrr: null,
      citationPrecision: null,
      contradictionUnknownRecall: null,
      semanticFindingPrecision: null,
      jsonSchemaReliability: null,
      roleIsolation: null,
      longContextAccuracy: null,
    },
    peakUnifiedMemoryBytes: null,
    p50LatencyMs: null,
    p95LatencyMs: null,
    measuredContextTokens: null,
    unqualifiedReason: "not-run",
  });
  expect(selectLocalDeployments([profile])).toEqual([]);
});

test("missing metric prevents selection even when other floors pass", () => {
  const profile = measuredProfile({
    metrics: {
      ...measuredProfile().metrics,
      citationPrecision: null,
    },
  });
  expect(selectLocalDeployments([profile])).toEqual([]);
});

test("below-floor metric prevents selection", () => {
  const profile = measuredProfile({
    metrics: {
      ...measuredProfile().metrics,
      jsonSchemaReliability: 0.5,
    },
  });
  expect(selectLocalDeployments([profile])).toEqual([]);
});

test("selection uses measuredContextTokens and never advertised extended window", () => {
  const onlyAdvertised = measuredProfile({
    profileId: "advertised-only",
    measuredContextTokens: null,
    advertisedExtendedTokens: 1_010_000,
  });
  expect(selectLocalDeployments([onlyAdvertised])).toEqual([]);
  const measured = measuredProfile({
    profileId: "measured-native",
    measuredContextTokens: 262144,
  });
  expect(selectLocalDeployments([measured])).toEqual(["measured-native"]);
});

test("tie-break prefers smaller peak memory then smaller parameter count then lexicographic Hugging Face id", () => {
  const heavy = measuredProfile({
    profileId: "heavy",
    huggingfaceId: "Qwen/Qwen3.6-35B-A3B",
    parameterCount: 35_000_000_000,
    peakUnifiedMemoryBytes: 80_000_000_000,
  });
  const lightLate = measuredProfile({
    profileId: "light-z",
    huggingfaceId: "Qwen/Z-light",
    parameterCount: 8_000_000_000,
    peakUnifiedMemoryBytes: 20_000_000_000,
  });
  const lightEarly = measuredProfile({
    profileId: "light-a",
    huggingfaceId: "Qwen/A-light",
    parameterCount: 8_000_000_000,
    peakUnifiedMemoryBytes: 20_000_000_000,
  });
  expect(selectLocalDeployments([heavy, lightLate, lightEarly])).toEqual(["light-a"]);
});

test("selects at most one winner per role", () => {
  const llm = measuredProfile({ profileId: "llm-1", role: "local-llm" });
  const embedA = measuredProfile({
    profileId: "emb-8b",
    role: "embedding",
    huggingfaceId: "Qwen/Qwen3-Embedding-8B",
    parameterCount: 8_000_000_000,
    peakUnifiedMemoryBytes: 16_000_000_000,
  });
  const embedB = measuredProfile({
    profileId: "emb-06b",
    role: "embedding",
    huggingfaceId: "Qwen/Qwen3-Embedding-0.6B",
    parameterCount: 600_000_000,
    peakUnifiedMemoryBytes: 2_000_000_000,
  });
  const ids = selectLocalDeployments([llm, embedA, embedB]);
  expect(ids).toEqual(["emb-06b", "llm-1"]);
});
