import type { PrimaryIntent, RiskOverlay, RunComposition, VerificationPackId } from "@pi-hec/contracts";
import { changeClassFor, defaultDeliveryFor } from "@pi-hec/domain";
import type { GoldenRepoId, TaskKind } from "./types.js";

export function primaryIntentForGoldenKind(kind: TaskKind): PrimaryIntent {
  switch (kind) {
    case "feature":
    case "ui":
      return "feature";
    case "bug":
      return "bugfix";
    case "refactor":
      return "refactor";
    case "spec":
      return "specification";
    case "research":
      return "research";
    case "security":
      return "security-remediation";
    case "migration":
      return "migration";
    case "performance":
      return "optimization";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function compositionForGoldenTask(kind: TaskKind, repoId: GoldenRepoId): RunComposition {
  const primaryIntent = primaryIntentForGoldenKind(kind);
  const overlays: RiskOverlay[] = [];
  const packs: VerificationPackId[] = [];
  switch (kind) {
    case "security":
      overlays.push("security-sensitive");
      packs.push("security");
      break;
    case "migration":
      if (repoId === "migration-public-api") {
        overlays.push("public-api");
      }
      overlays.push("migration");
      packs.push("database");
      break;
    case "ui":
      overlays.push("ui-visible");
      packs.push("web-ui");
      break;
    case "performance":
      packs.push("performance");
      break;
    case "feature":
    case "bug":
    case "refactor":
    case "spec":
    case "research":
      break;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
  const urgency = "normal" as const;
  return {
    schemaVersion: 2,
    primaryIntent,
    secondaryIntents: [],
    overlays,
    verificationPacks: packs,
    deliveryMode: defaultDeliveryFor(primaryIntent, urgency),
    urgency,
    executionBudget: overlays.some(
      (overlay) =>
        overlay === "security-sensitive" || overlay === "public-api" || overlay === "migration",
    )
      ? "thorough"
      : "standard",
    changeClass: changeClassFor(primaryIntent),
  };
}
