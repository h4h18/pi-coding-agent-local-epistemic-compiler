import type { RiskFlag, TaskKind } from "@pi-hec/contracts";

export const HARD_SKILL_RULES: readonly {
  when: {
    kinds?: readonly TaskKind[];
    riskFlags?: readonly RiskFlag[];
    behaviorChange?: boolean;
  };
  skillIds: readonly string[];
}[] = [
  { when: { kinds: ["bugfix"] }, skillIds: ["debugging", "project-testing"] },
  { when: { kinds: ["refactor"] }, skillIds: ["behavior-preservation", "project-architecture"] },
  { when: { kinds: ["spec"] }, skillIds: ["spec-read", "spec-write"] },
  { when: { behaviorChange: true }, skillIds: ["spec-read", "spec-write"] },
  { when: { riskFlags: ["public-api"] }, skillIds: ["api-compatibility"] },
  { when: { riskFlags: ["migration"] }, skillIds: ["migration-safety"] },
];

export function mandatorySkillIdsFor(input: {
  kind: TaskKind;
  riskFlags: readonly RiskFlag[];
  behaviorChange: boolean;
}): string[] {
  const selected = new Set<string>();
  for (const rule of HARD_SKILL_RULES) {
    if (rule.when.kinds !== undefined && !rule.when.kinds.includes(input.kind)) {
      continue;
    }
    if (
      rule.when.riskFlags !== undefined &&
      !rule.when.riskFlags.some((flag) => input.riskFlags.includes(flag))
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
