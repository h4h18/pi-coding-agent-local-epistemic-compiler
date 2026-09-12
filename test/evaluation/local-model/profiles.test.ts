import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { QUALITY_FLOORS, loadModelConfigDirectory, selectLocalDeployments } from "@pi-hec/models";
import { repoRoot } from "./paths.js";

const modelsDir = path.join(repoRoot(), "faex1", "config", "models");

test("every faex1/config/models JSON parses and local profiles share the required fields", async () => {
  const loaded = await loadModelConfigDirectory(modelsDir);
  expect(loaded.localProfiles.length).toBeGreaterThanOrEqual(3);
  const hfIds = new Set(loaded.localProfiles.map((profile) => profile.huggingfaceId));
  expect(hfIds.has("Qwen/Qwen3.6-35B-A3B")).toBe(true);
  expect(hfIds.has("Qwen/Qwen3.6-27B")).toBe(true);
  expect(hfIds.has("Qwen/Qwen3.8-27B")).toBe(true);
  expect(hfIds.has("Qwen/Qwen3-Embedding-0.6B")).toBe(true);
  expect(hfIds.has("Qwen/Qwen3-Reranker-0.6B")).toBe(true);
  expect(hfIds.has("Qwen/Qwen3-Embedding-4B")).toBe(true);
  expect(hfIds.has("Qwen/Qwen3-Embedding-8B")).toBe(true);
  expect(hfIds.has("Qwen/Qwen3-Reranker-4B")).toBe(true);
  expect(hfIds.has("Qwen/Qwen3-Reranker-8B")).toBe(true);
  for (const profile of loaded.localProfiles) {
    expect(profile.schemaVersion).toBe(1);
    expect(["unqualified", "measured", "selected"]).toContain(profile.qualificationStatus);
    expect(typeof profile.selected).toBe("boolean");
    expect(typeof profile.runtimeId).toBe("string");
    expect(profile.adapterSurface.implementsCloudCompletion).toBe(false);
    expect(profile.adapterSurface.exposesRepositoryTools).toBe(false);
    expect(Object.keys(profile.metrics).sort()).toEqual(Object.keys(QUALITY_FLOORS).sort());
  }
});

test("runtime slots include selected llama.cpp Vulkan and unqualified vLLM/SGLang/HIP", async () => {
  const loaded = await loadModelConfigDirectory(modelsDir);
  const runtimeIds = new Set(loaded.runtimeSlots.map((slot) => slot.runtimeId));
  expect(runtimeIds.has("vllm-rocm-linux")).toBe(true);
  expect(runtimeIds.has("llamacpp-hip-linux")).toBe(true);
  expect(runtimeIds.has("llamacpp-vulkan-linux")).toBe(true);
  expect(runtimeIds.has("sglang-gfx1151")).toBe(true);
  const vulkan = loaded.runtimeSlots.find((slot) => slot.runtimeId === "llamacpp-vulkan-linux");
  expect(vulkan?.qualificationStatus).toBe("selected");
  expect(vulkan?.selected).toBe(true);
  expect(vulkan?.bindPort).toBe(8000);
  const sglang = loaded.runtimeSlots.find((slot) => slot.runtimeId === "sglang-gfx1151");
  expect(sglang?.qualificationStatus).toBe("unqualified");
  expect(sglang?.selected).toBe(false);
  const vllm = loaded.runtimeSlots.find((slot) => slot.runtimeId === "vllm-rocm-linux");
  expect(vllm?.selected).toBe(false);
});

test("selected set operator-pins Qwen3.8-27B; quality floors remain unmet", async () => {
  const loaded = await loadModelConfigDirectory(modelsDir);
  expect(loaded.selectedIds).toEqual(["qwen3.8-27b-llamacpp-vulkan-linux"]);
  expect(loaded.operatorPin).toBe(true);
  const selected = loaded.localProfiles.find((profile) => profile.selected);
  expect(selected?.huggingfaceId).toBe("Qwen/Qwen3.8-27B");
  expect(selected?.runtimeId).toBe("llamacpp-vulkan-linux");
  expect(selected?.qualificationStatus).toBe("selected");
  expect(selectLocalDeployments(loaded.localProfiles)).toEqual([]);
});

test("no numeric performance field is non-null without a pinned evidence artifact", async () => {
  const loaded = await loadModelConfigDirectory(modelsDir);
  for (const profile of loaded.localProfiles) {
    const numeric =
      profile.peakUnifiedMemoryBytes !== null ||
      profile.p50LatencyMs !== null ||
      profile.p95LatencyMs !== null ||
      profile.measuredContextTokens !== null ||
      Object.values(profile.metrics).some((value) => value !== null);
    if (numeric) {
      expect(profile.evidence.length).toBeGreaterThan(0);
      for (const item of profile.evidence) {
        expect(item.artifactSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    }
    if (profile.selected) {
      expect(profile.weightPin).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  }
});

test("advertised extended context is labeled advertised and is not the production default", async () => {
  const loaded = await loadModelConfigDirectory(modelsDir);
  const qwen36_27 = loaded.localProfiles.find(
    (profile) => profile.huggingfaceId === "Qwen/Qwen3.6-27B",
  );
  const qwen36_35 = loaded.localProfiles.find(
    (profile) => profile.huggingfaceId === "Qwen/Qwen3.6-35B-A3B",
  );
  const qwen38_27 = loaded.localProfiles.find(
    (profile) => profile.huggingfaceId === "Qwen/Qwen3.8-27B",
  );
  expect(qwen36_27?.advertisedNativeTokens).toBe(262144);
  expect(qwen36_27?.advertisedExtendedTokens).toBe(1_010_000);
  expect(qwen36_35?.advertisedNativeTokens).toBe(262144);
  expect(qwen36_35?.advertisedExtendedTokens).toBe(1_010_000);
  expect(qwen38_27?.advertisedNativeTokens).toBe(262144);
  expect(qwen38_27?.advertisedExtendedTokens).toBe(1_000_000);
  expect(qwen36_27?.measuredContextTokens).toBeNull();
  expect(qwen36_35?.measuredContextTokens).toBeNull();
  expect(qwen38_27?.measuredContextTokens).toBe(262144);
  expect(qwen38_27?.measuredMaxOutputTokens).toBe(32768);
});

test("faex1/config/models directory contains only parseable JSON files", async () => {
  const names = await readdir(modelsDir);
  const jsonFiles = names.filter((name) => name.endsWith(".json"));
  expect(jsonFiles.length).toBeGreaterThan(0);
  for (const name of jsonFiles) {
    const raw = await readFile(path.join(modelsDir, name), "utf8");
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
  }
});
