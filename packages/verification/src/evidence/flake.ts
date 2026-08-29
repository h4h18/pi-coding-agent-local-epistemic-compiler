import type { EvidenceRecord, RunObservation } from "@pi-hec/contracts";
import { FLAKE_STATISTICAL_POLICY } from "./policy.js";

export type FlakeClass = "stable-pass" | "stable-fail" | "unknown-instability";

export function sprtBounds(policy: typeof FLAKE_STATISTICAL_POLICY = FLAKE_STATISTICAL_POLICY): {
  acceptH1: number;
  acceptH0: number;
} {
  const acceptH1 = Math.log((1 - policy.beta) / policy.alpha);
  const acceptH0 = Math.log(policy.beta / (1 - policy.alpha));
  return { acceptH1, acceptH0 };
}

export function classifyFlake(
  observations: readonly RunObservation[],
  policy: typeof FLAKE_STATISTICAL_POLICY = FLAKE_STATISTICAL_POLICY,
): FlakeClass {
  const retained = [...observations];
  if (retained.length === 0) {
    return "unknown-instability";
  }
  const failed = retained.filter((item) => item.state === "FAILED" || item.state === "ERROR");
  const passed = retained.filter((item) => item.state === "PASSED");
  if (failed.length > 0 && passed.length > 0) {
    return "unknown-instability";
  }
  if (retained.length < policy.minObservations) {
    return "unknown-instability";
  }
  const bounds = sprtBounds(policy);
  const p0 = clampUnit(0.5 - policy.effect / 2);
  const p1 = clampUnit(0.5 + policy.effect / 2);
  const systematicFail = failed.length > 0 && passed.length === 0;
  let llr = 0;
  for (const item of retained) {
    const isFail = item.state === "FAILED" || item.state === "ERROR";
    const isPass = item.state === "PASSED";
    if (!isFail && !isPass) {
      continue;
    }
    const success = systematicFail ? isFail : isPass;
    llr += success ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
  }
  if (llr >= bounds.acceptH1) {
    return systematicFail ? "stable-fail" : "stable-pass";
  }
  if (llr <= bounds.acceptH0) {
    return "unknown-instability";
  }
  return "unknown-instability";
}

export function pairedFlake(input: {
  baseline: readonly RunObservation[];
  candidate: readonly RunObservation[];
}): FlakeClass {
  const baselineClass = classifyFlake(input.baseline);
  const candidateClass = classifyFlake(input.candidate);
  if (candidateClass === "stable-fail" && baselineClass === "stable-pass") {
    return "stable-fail";
  }
  if (baselineClass === "unknown-instability" && candidateClass === "unknown-instability") {
    return "unknown-instability";
  }
  if (candidateClass === "stable-pass" && baselineClass === "stable-pass") {
    return "stable-pass";
  }
  if (candidateClass === "stable-fail" && baselineClass === "stable-fail") {
    return "unknown-instability";
  }
  return "unknown-instability";
}

export function observationsRetained(record: EvidenceRecord): readonly RunObservation[] {
  return record.observations;
}

function clampUnit(value: number): number {
  if (value < 0.01) {
    return 0.01;
  }
  if (value > 0.99) {
    return 0.99;
  }
  return value;
}
