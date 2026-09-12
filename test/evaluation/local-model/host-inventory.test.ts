import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { collectHostInventory, loadCommittedHostInventory } from "./host-inventory.js";
import { evaluateLiveLoopback, resolveLiveInferenceBaseUrl } from "./live-client.js";
import { startMockOpenAiServer } from "./mock-server.js";
import { QUALITY_FLOORS, loadModelConfigDirectory } from "@pi-hec/models";
import { repoRoot } from "./paths.js";

test("live host inventory probe reports a known OS family", async () => {
  const live = await collectHostInventory();
  expect(
    live.osFamily === "windows" || live.osFamily === "linux" || live.osFamily === "darwin",
  ).toBe(true);
});

test("committed FA-EX1 inventory records Strix Halo gfx1151 unified memory", async () => {
  const committed = await loadCommittedHostInventory(
    path.join(repoRoot(), "faex1", "config", "models", "host-inventory.json"),
  );
  expect(committed.osFamily).toBe("linux");
  expect(committed.nvidiaPresent).toBe(false);
  expect(committed.cudaPresent).toBe(false);
  expect(committed.amdGpuNames.join(" ")).toMatch(/8060S/i);
  expect(committed.vramBytesByGpu[0]).toBe(103079215104);
  const joined = `${committed.gpuNames.join(" ")} ${committed.notes.join(" ")}`.toLowerCase();
  expect(joined).toMatch(/fa-ex1|qwen3\.8-27b/);
  expect(joined).toMatch(/262144/);
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
  expect(() =>
    resolveLiveInferenceBaseUrl({ PI_HEC_EVAL_LIVE_BASE_URL: "http://0.0.0.0:8000" }),
  ).toThrow(/loopback/);
});

test("role isolation config invariant: local forbids cloud completion, cloud forbids repository tools", async () => {
  const loaded = await loadModelConfigDirectory(path.join(repoRoot(), "faex1", "config", "models"));
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
