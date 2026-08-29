import { Compile } from "typebox/compile";
import type { Static } from "typebox";
import {
  LoadedSkillBodySchema,
  SkillManifestSchema,
  type SkillDescriptor,
  type SkillManifest,
  type SnapshotId,
  type SourceRef,
} from "@pi-hec/contracts";
import { isPathInsideRoot, nfc } from "./context-discovery.js";
import { mandatorySkillIdsFromInstructions, type EffectiveInstruction } from "./scope-trie.js";
import type { DiscoveredSkill, SkillDiscoveryResult } from "./skill-discovery.js";

const SKILL_MANIFEST = Compile(SkillManifestSchema);
const LOADED_SKILL = Compile(LoadedSkillBodySchema);
const DEFAULT_MAX_BODY_BYTES = 262144;

type LoadedSkillBody = Static<typeof LoadedSkillBodySchema>;

export type SkillResolverInput = {
  snapshotId: SnapshotId;
  discovery: SkillDiscoveryResult;
  instructionChain: readonly EffectiveInstruction[];
  touchedPaths: readonly string[];
  provenSkillIds?: readonly string[];
  proposedSkillIds?: readonly string[];
  tokenBudget: number;
  estimateTokens?: (text: string) => number;
  maxSkillBodyBytes?: number;
};

export type SkillResolverResult = {
  manifest: SkillManifest;
  loadedSkills: readonly LoadedSkillBody[];
  omittedSkillIds: readonly string[];
};

export function resolveSkills(input: SkillResolverInput): SkillResolverResult {
  const byId = new Map(input.discovery.skills.map((skill) => [skill.descriptor.id, skill]));
  const conflicts: SkillManifest["conflicts"] = [...input.discovery.conflicts];
  const maxBody = input.maxSkillBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const estimate = input.estimateTokens ?? defaultEstimateTokens;

  const mandatory = orderedUnique([
    ...mandatorySkillIdsFromInstructions(input.instructionChain),
    ...input.discovery.skills
      .filter((skill) => skill.descriptor.loadPolicy === "mandatory" && isTrusted(skill))
      .map((skill) => skill.descriptor.id),
  ]).filter((id) => byId.has(id));

  const pathScoped = input.discovery.skills
    .filter((skill) => isPathScoped(skill, input.touchedPaths) && isTrusted(skill))
    .map((skill) => skill.descriptor.id)
    .filter((id) => byId.has(id));

  const proven = orderedUnique(input.provenSkillIds ?? []).filter((id) => {
    const skill = byId.get(id);
    return skill !== undefined && isTrusted(skill);
  });
  const include = orderedUnique([...mandatory, ...pathScoped, ...proven]);
  const { closed, cyclic } = closeDependencies(include, byId, conflicts);
  const highApplicability = new Set(
    [...mandatory, ...pathScoped, ...proven, ...closed].filter((id) => {
      if (cyclic.has(id)) {
        return false;
      }
      const skill = byId.get(id);
      return skill !== undefined && isTrusted(skill);
    }),
  );

  for (const proposed of input.proposedSkillIds ?? []) {
    if (!byId.has(nfc(proposed))) {
      continue;
    }
  }

  const loaded: LoadedSkillBody[] = [];
  const omitted: string[] = [];
  const descriptors: SkillDescriptor[] = [];
  let usedTokens = 0;

  for (const skill of input.discovery.skills) {
    const descriptor = withLoadPolicy(skill, mandatory, highApplicability);
    descriptors.push(descriptor);
    const oversized = skill.bytes.byteLength > maxBody;
    if (oversized && highApplicability.has(skill.descriptor.id)) {
      conflicts.push({
        skillIds: [skill.descriptor.id],
        sourceRefs: [skill.descriptor.sourceRef],
        reason: `oversized skill body for ${skill.descriptor.id}`,
      });
      continue;
    }
    const shouldLoadBody = highApplicability.has(skill.descriptor.id) && !oversized;
    if (!shouldLoadBody) {
      omitted.push(skill.descriptor.id);
      continue;
    }
    const tokens = estimate(skill.body);
    if (
      !mandatory.includes(skill.descriptor.id) &&
      !pathScoped.includes(skill.descriptor.id) &&
      !proven.includes(skill.descriptor.id) &&
      usedTokens + tokens > input.tokenBudget
    ) {
      omitted.push(skill.descriptor.id);
      continue;
    }
    const loadedBody: LoadedSkillBody = {
      skillId: skill.descriptor.id,
      descriptor,
      verbatimContent: skill.body,
    };
    if (!LOADED_SKILL.Check(loadedBody)) {
      conflicts.push({
        skillIds: [skill.descriptor.id],
        sourceRefs: [skill.descriptor.sourceRef],
        reason: `loaded skill body schema invalid for ${skill.descriptor.id}`,
      });
      continue;
    }
    loaded.push(loadedBody);
    usedTokens += tokens;
  }

  loaded.sort((left, right) => (left.skillId < right.skillId ? -1 : 1));
  omitted.sort();
  descriptors.sort((left, right) => (left.id < right.id ? -1 : 1));
  const manifest: SkillManifest = {
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    skills: descriptors,
    conflicts: sortConflicts(conflicts),
  };
  if (!SKILL_MANIFEST.Check(manifest)) {
    throw new Error("skill manifest schema invalid");
  }
  return { manifest, loadedSkills: loaded, omittedSkillIds: omitted };
}

function closeDependencies(
  roots: readonly string[],
  byId: ReadonlyMap<string, DiscoveredSkill>,
  conflicts: SkillManifest["conflicts"],
): { closed: string[]; cyclic: Set<string> } {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: string[] = [];
  const cycleIds = new Set<string>();

  function visit(id: string, stack: string[]): void {
    if (visited.has(id) || cycleIds.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = start >= 0 ? stack.slice(start) : [...stack, id];
      for (const item of cycle) {
        cycleIds.add(item);
      }
      const refs: SourceRef[] = [];
      for (const item of cycle) {
        const skill = byId.get(item);
        if (skill !== undefined) {
          refs.push(skill.descriptor.sourceRef);
        }
      }
      conflicts.push({
        skillIds: [...cycle],
        sourceRefs: refs,
        reason: `dependency cycle involving ${cycle.join(" -> ")}`,
      });
      return;
    }
    const skill = byId.get(id);
    if (skill === undefined) {
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const dep of skill.dependencies) {
      visit(dep, stack);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }

  for (const id of roots) {
    visit(id, []);
  }
  return { closed: ordered.filter((id) => !cycleIds.has(id)), cyclic: cycleIds };
}

function isPathScoped(skill: DiscoveredSkill, touchedPaths: readonly string[]): boolean {
  if (skill.pathScope === ".") {
    return false;
  }
  return touchedPaths.some(
    (path) => path === skill.pathScope || isPathInsideRoot(skill.pathScope, path),
  );
}

function isTrusted(skill: DiscoveredSkill): boolean {
  return skill.trust === "platform" || skill.trust === "user" || skill.trust === "trusted-project";
}

function withLoadPolicy(
  skill: DiscoveredSkill,
  mandatory: readonly string[],
  highApplicability: ReadonlySet<string>,
): SkillDescriptor {
  let loadPolicy: SkillDescriptor["loadPolicy"] = "on-request";
  if (mandatory.includes(skill.descriptor.id)) {
    loadPolicy = "mandatory";
  } else if (highApplicability.has(skill.descriptor.id)) {
    loadPolicy = "applicable";
  }
  return { ...skill.descriptor, loadPolicy };
}

function orderedUnique(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = nfc(raw);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function defaultEstimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function sortConflicts(conflicts: SkillManifest["conflicts"]): SkillManifest["conflicts"] {
  return [...conflicts].sort((left, right) => {
    const leftKey = left.skillIds.join("\0");
    const rightKey = right.skillIds.join("\0");
    if (leftKey === rightKey) {
      return left.reason < right.reason ? -1 : 1;
    }
    return leftKey < rightKey ? -1 : 1;
  });
}
