import { objectDigestFromBytes, type ObjectDigest } from "@pi-hec/contracts";
import { toJsonValue } from "../plan/envelope.js";

export const ADMISSIBILITY_POLICY = {
  schemaVersion: 1,
  policyId: "pi-hec-evidence-admissibility/v1",
  forbiddenOrigins: ["LOCAL_MODEL", "CLOUD_CLAIM"] as const,
  requireBaselineSealMatch: true,
  requireProducerRegistry: true,
} as const;

export const FLAKE_STATISTICAL_POLICY = {
  schemaVersion: 1,
  policyId: "pi-hec-flake-sprt/v1",
  alpha: 0.05,
  beta: 0.2,
  effect: 0.5,
  minObservations: 3,
} as const;

export function policyRevisionDigest(): ObjectDigest {
  return objectDigestFromBytes(
    Buffer.from(
      JSON.stringify(
        toJsonValue({
          admissibility: ADMISSIBILITY_POLICY,
          flake: FLAKE_STATISTICAL_POLICY,
        }),
      ),
      "utf8",
    ),
  );
}
