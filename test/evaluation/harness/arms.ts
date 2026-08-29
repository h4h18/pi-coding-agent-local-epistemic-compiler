import type { ArmId, ArmRole } from "./types.js";

export type ArmDefinition = {
  readonly id: ArmId;
  readonly name: string;
  readonly role: ArmRole;
};

export const ARM_DEFINITIONS: Readonly<Record<ArmId, ArmDefinition>> = {
  1: { id: 1, name: "ordinary-pi-baseline", role: "primary" },
  2: { id: 2, name: "cloud-one-shot-no-aep", role: "diagnostic" },
  3: { id: 3, name: "hec-first-completion", role: "primary" },
  4: { id: 4, name: "hec-final-after-repair", role: "diagnostic" },
};

export function isProductionGateArm(armId: ArmId): boolean {
  return ARM_DEFINITIONS[armId].role === "primary";
}

export function rejectDiagnosticGateEvidence(armId: ArmId): void {
  if (!isProductionGateArm(armId)) {
    throw new Error(`${ARM_DEFINITIONS[armId].name} is diagnostic and cannot satisfy the production gate`);
  }
}
