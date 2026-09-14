import type { PrimaryIntent, RiskFlag, RiskOverlay, TaskKind } from "@pi-hec/contracts";

export const HARD_SKILL_RULES: readonly {
  when: {
    kinds?: readonly TaskKind[];
    intents?: readonly PrimaryIntent[];
    riskFlags?: readonly RiskFlag[];
    overlays?: readonly RiskOverlay[];
    behaviorChange?: boolean;
  };
  skillIds: readonly string[];
}[] = [
  { when: { kinds: ["bugfix"] }, skillIds: ["debugging", "project-testing"] },
  { when: { intents: ["bugfix", "incident-response", "diagnosis"] }, skillIds: ["debugging", "project-testing"] },
  { when: { kinds: ["refactor"] }, skillIds: ["behavior-preservation", "project-architecture"] },
  { when: { intents: ["refactor"] }, skillIds: ["behavior-preservation", "project-architecture"] },
  { when: { kinds: ["spec"] }, skillIds: ["spec-read", "spec-write"] },
  { when: { intents: ["specification", "requirements", "architecture-design"] }, skillIds: ["spec-read", "spec-write"] },
  { when: { behaviorChange: true }, skillIds: ["spec-read", "spec-write"] },
  { when: { riskFlags: ["public-api"] }, skillIds: ["api-compatibility"] },
  { when: { overlays: ["public-api"] }, skillIds: ["api-compatibility"] },
  { when: { riskFlags: ["migration"] }, skillIds: ["migration-safety"] },
  { when: { overlays: ["migration", "data-mutation"] }, skillIds: ["migration-safety"] },
  { when: { overlays: ["security-sensitive", "authentication"] }, skillIds: ["security-review"] },
  { when: { intents: ["security-remediation"] }, skillIds: ["security-review", "debugging"] },
  { when: { intents: ["optimization"] }, skillIds: ["performance-budget"] },
];

export function mandatorySkillIdsFor(input: {
  kind: TaskKind;
  riskFlags: readonly RiskFlag[];
  behaviorChange: boolean;
  primaryIntent?: PrimaryIntent;
  overlays?: readonly RiskOverlay[];
}): string[] {
  const selected = new Set<string>();
  for (const rule of HARD_SKILL_RULES) {
    if (rule.when.kinds !== undefined && !rule.when.kinds.includes(input.kind)) {
      continue;
    }
    if (
      rule.when.intents !== undefined &&
      (input.primaryIntent === undefined || !rule.when.intents.includes(input.primaryIntent))
    ) {
      continue;
    }
    if (
      rule.when.riskFlags !== undefined &&
      !rule.when.riskFlags.some((flag) => input.riskFlags.includes(flag))
    ) {
      continue;
    }
    if (
      rule.when.overlays !== undefined &&
      (input.overlays === undefined ||
        !rule.when.overlays.some((overlay) => input.overlays?.includes(overlay)))
    ) {
      continue;
    }
    if (rule.when.behaviorChange === true && !input.behaviorChange) {
      continue;
    }
    for (const skillId of rule.skillIds) {
      selected.add(skillId);
    }
  }
  return [...selected].sort();
}
