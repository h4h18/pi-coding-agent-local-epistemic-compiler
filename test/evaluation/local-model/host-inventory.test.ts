import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { collectHostInventory, loadCommittedHostInventory } from "./host-inventory.js";
import { evaluateLiveLoopback, resolveLiveInferenceBaseUrl } from "./live-client.js";
import { startMockOpenAiServer } from "./mock-server.js";
import { QUALITY_FLOORS, loadModelConfigDirectory } from "@pi-hec/models";
import { repoRoot } from "./paths.js";

test("host inventory does not claim AMD ROCm on this NVIDIA laptop", async () => {
  const live = await collectHostInventory();
  expect(live.osFamily === "windows" || live.osFamily === "linux" || live.osFamily === "darwin").toBe(
    true,
  );
  expect(live.rocmPresent).toBe(false);
  expect(live.hipPresent).toBe(false);
  expect(live.amdGpuNames).toEqual([]);
  const committed = await loadCommittedHostInventory(
    path.join(repoRoot(), "config", "models", "host-inventory.json"),
  );
  expect(committed.rocmPresent).toBe(false);
  expect(committed.hipPresent).toBe(false);
  expect(committed.amdGpuNames).toEqual([]);
  const joined = `${committed.gpuNames.join(" ")} ${committed.notes.join(" ")}`.toLowerCase();
  expect(joined.includes("rocm")).toBe(false);
  expect(joined).toMatch(/rtx 4050/i);
  expect(joined).toMatch(/intel arc/i);
  expect(joined).toMatch(/meta virtual monitor/i);
});

test("Windows inventory helper queries Win32_VideoController", async () => {
  const ps1 = await readFile(
    path.join(repoRoot(), "test", "evaluation", "local-model", "scripts", "inventory-host.ps1"),
    "utf8",
  );
  expect(ps1.includes("Win32_VideoController")).toBe(true);
  expect(ps1.includes("Get-CimInstance")).toBe(true);
});

test("live loopback evaluation posts datasets and returns finite metric computers", async () => {
  const server = await startMockOpenAiServer({
    advertisedContextTokens: 262144,
    measuredContextTokens: 2048,
  });
  try {
    const metrics = await evaluateLiveLoopback(server.baseUrl);
    expect(Object.keys(metrics).sort()).toEqual(Object.keys(QUALITY_FLOORS).sort());
    for (const value of Object.values(metrics)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(server.requestCount).toBeGreaterThan(0);
    await expect(evaluateLiveLoopback("http://192.168.1.5:8000")).rejects.toThrow(/loopback/);
  } finally {
    await server.close();
  }
});

test("live inference client stays on loopback unless FA-EX1 env is documented and still loopback", () => {
  expect(resolveLiveInferenceBaseUrl({})).toBeUndefined();
  expect(resolveLiveInferenceBaseUrl({ PI_HEC_EVAL_LIVE_BASE_URL: "http://127.0.0.1:8000" })).toBe(
    "http://127.0.0.1:8000",
  );
  expect(() =>
    resolveLiveInferenceBaseUrl({ PI_HEC_EVAL_LIVE_BASE_URL: "http://192.168.1.5:8000" }),
  ).toThrow(/loopback/);
  expect(() => resolveLiveInferenceBaseUrl({ PI_HEC_EVAL_LIVE_BASE_URL: "http://0.0.0.0:8000" })).toThrow(
    /loopback/,
  );
});

test("role isolation config invariant: local forbids cloud completion, cloud forbids repository tools", async () => {
  const loaded = await loadModelConfigDirectory(path.join(repoRoot(), "config", "models"));
  for (const profile of loaded.localProfiles) {
    expect(profile.adapterSurface.implementsCloudCompletion).toBe(false);
    expect(profile.adapterSurface.exposesRepositoryTools).toBe(false);
  }
  expect(loaded.roleIsolation.cloudAdapter.exposesRepositoryTools).toBe(false);
  expect(loaded.roleIsolation.cloudAdapter.allowedTerminalTools).toEqual([
    "submit_solution",
    "request_context",
  ]);
});
