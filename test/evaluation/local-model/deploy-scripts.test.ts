import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { repoRoot } from "./paths.js";
import { sglangIsRefused } from "./sglang-gate.js";

const inferenceDir = path.join(repoRoot(), "faex1", "deploy", "inference");

async function scriptText(): Promise<string> {
  const names = await readdir(inferenceDir);
  const scripts = names.filter((name) => name.endsWith(".sh"));
  expect(scripts.length).toBeGreaterThanOrEqual(4);
  const parts: string[] = [];
  for (const name of scripts) {
    parts.push(await readFile(path.join(inferenceDir, name), "utf8"));
  }
  return parts.join("\n");
}

test("FA-EX1 inference scripts bind 127.0.0.1 only", async () => {
  const text = await scriptText();
  expect(text.includes("127.0.0.1")).toBe(true);
  expect(text.includes("0.0.0.0")).toBe(false);
});

test("vLLM 0.27 structured outputs use structured_outputs / json, not guided_json", async () => {
  const text = await readFile(path.join(inferenceDir, "run-vllm.sh"), "utf8");
  expect(text.includes("structured_outputs")).toBe(true);
  expect(text.includes("guided_json")).toBe(false);
  expect(text.includes("0.27.0")).toBe(true);
  expect(text.includes("--host")).toBe(true);
  expect(text.includes("127.0.0.1")).toBe(true);
});

test("ROCm installer pins 7.2.1 and fails without gfx1150/gfx1151", async () => {
  const text = await readFile(path.join(inferenceDir, "install-rocm.sh"), "utf8");
  expect(text.includes("7.2.1")).toBe(true);
  expect(text.includes("gfx1150")).toBe(true);
  expect(text.includes("gfx1151")).toBe(true);
  expect(text.includes("rocminfo")).toBe(true);
});

test("llama.cpp pin is 0.4.0 / b10809 with GGUF hash verification", async () => {
  const text = await readFile(path.join(inferenceDir, "run-llamacpp.sh"), "utf8");
  const convert = await readFile(path.join(inferenceDir, "convert-gguf.sh"), "utf8");
  const install = await readFile(path.join(inferenceDir, "install-llamacpp.sh"), "utf8");
  expect(text.includes("0.4.0")).toBe(true);
  expect(text.includes("b10809") || install.includes("b10809")).toBe(true);
  expect(text.includes("127.0.0.1")).toBe(true);
  expect(text.includes("262144")).toBe(true);
  expect(convert.includes("convert_hf_to_gguf.py")).toBe(true);
  expect(convert.includes("sha256")).toBe(true);
});

test("SGLang wrapper refuses without a gfx1151 qualification record", async () => {
  const text = await readFile(path.join(inferenceDir, "run-sglang.sh"), "utf8");
  expect(text.includes("gfx1151")).toBe(true);
  expect(sglangIsRefused({ gfx1151QualificationRecord: null })).toBe(true);
  expect(
    sglangIsRefused({
      gfx1151QualificationRecord: {
        runtimeId: "sglang-gfx1151",
        qualificationStatus: "unqualified",
      },
    }),
  ).toBe(true);
  expect(
    sglangIsRefused({
      gfx1151QualificationRecord: {
        runtimeId: "sglang-gfx1151",
        qualificationStatus: "measured",
      },
    }),
  ).toBe(false);
});

test("vLLM ROCm script does not claim an unverified rocm721 0.27.0 gfx1151 wheel", async () => {
  const text = await readFile(path.join(inferenceDir, "run-vllm.sh"), "utf8");
  expect(text.includes("171775f306a333a9cf105bfd533bf3e113d401d9")).toBe(true);
  expect(text.includes("nightly")).toBe(true);
});

test("vLLM install is fail-closed hashed requirements with no unpinned pip fallback", async () => {
  const text = await readFile(path.join(inferenceDir, "run-vllm.sh"), "utf8");
  expect(text.includes("--require-hashes")).toBe(true);
  expect(text.includes("-r")).toBe(true);
  expect(text.includes("|| python3 -m pip install")).toBe(false);
  expect(text.includes("|| pip install")).toBe(false);
});

test("SGLang allows measured or selected and refuses unqualified", async () => {
  const text = await readFile(path.join(inferenceDir, "run-sglang.sh"), "utf8");
  expect(text.includes('"measured"')).toBe(true);
  expect(text.includes('"selected"')).toBe(true);
  expect(sglangIsRefused({ gfx1151QualificationRecord: null })).toBe(true);
  expect(
    sglangIsRefused({
      gfx1151QualificationRecord: {
        runtimeId: "sglang-gfx1151",
        qualificationStatus: "unqualified",
      },
    }),
  ).toBe(true);
  expect(
    sglangIsRefused({
      gfx1151QualificationRecord: {
        runtimeId: "wrong-runtime",
        qualificationStatus: "measured",
      },
    }),
  ).toBe(true);
  expect(
    sglangIsRefused({
      gfx1151QualificationRecord: {
        runtimeId: "sglang-gfx1151",
        qualificationStatus: "measured",
      },
    }),
  ).toBe(false);
  expect(
    sglangIsRefused({
      gfx1151QualificationRecord: {
        runtimeId: "sglang-gfx1151",
        qualificationStatus: "selected",
      },
    }),
  ).toBe(false);
});

test("llama.cpp HIP configure pins gfx1150 and gfx1151 via AMDGPU_TARGETS", async () => {
  const text = await readFile(path.join(inferenceDir, "run-llamacpp.sh"), "utf8");
  expect(text.includes("AMDGPU_TARGETS")).toBe(true);
  expect(text.includes("gfx1150")).toBe(true);
  expect(text.includes("gfx1151")).toBe(true);
  expect(text.includes("GGML_HIP=ON")).toBe(true);
});

test("PyTorch 2.9.1 FA-EX1 installer pins AMD Ryzen index and asserts version", async () => {
  const text = await readFile(path.join(inferenceDir, "install-pytorch.sh"), "utf8");
  expect(text.includes("2.9.1")).toBe(true);
  expect(text.includes("startswith('2.9.1')") || text.includes('startswith("2.9.1")')).toBe(true);
  expect(text.includes("repo.radeon.com")).toBe(true);
  expect(text.includes("3.12")).toBe(true);
  expect(text.includes("rocm-rel-7.2.1")).toBe(true);
  expect(/pip3 install torch(?![^\n]*2\.9\.1)/.test(text)).toBe(false);
});
