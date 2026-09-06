import type { RunObservation } from "@pi-hec/contracts";

export type RedGreenTest = {
  name: string;
  bytesDigest: string;
  baselineObservations: readonly RunObservation[];
  candidateObservations: readonly RunObservation[];
  targetsRequirement: boolean;
  importFailure: boolean;
  requirementAddsPublicSymbol: boolean;
};

export type RedGreenResult =
  "reproduction" | "not-red" | "wrong-red-reason" | "not-green" | "not-reproduction";

export function evaluateRedGreen(test: RedGreenTest): RedGreenResult {
  const baselineFailed = test.baselineObservations.some((item) => item.state === "FAILED");
  const baselinePassed = test.baselineObservations.every((item) => item.state === "PASSED");
  const candidatePassed = test.candidateObservations.every((item) => item.state === "PASSED");
  if (baselinePassed) {
    return "not-reproduction";
  }
  if (!baselineFailed) {
    return "not-red";
  }
  if (test.importFailure && !test.requirementAddsPublicSymbol) {
    return "wrong-red-reason";
  }
  if (!test.targetsRequirement) {
    return "wrong-red-reason";
  }
  if (!candidatePassed) {
    return "not-green";
  }
  return "reproduction";
}
