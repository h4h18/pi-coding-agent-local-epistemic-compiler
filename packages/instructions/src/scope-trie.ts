import { Compile } from "typebox/compile";
import {
  InstructionManifestSchema,
  type InstructionManifest,
  type SnapshotId,
} from "@pi-hec/contracts";
import {
  MODEL_CONTEXT_MISSING,
  ancestorScopes,
  instructionDescriptor,
  parseYamlFrontmatter,
  posixDirname,
  yamlMap,
  yamlStringList,
  type DiscoveredContextFile,
  type ContextDiscoveryResult,
  type TrustLabel,
} from "./context-discovery.js";

const INSTRUCTION_MANIFEST = Compile(InstructionManifestSchema);

export type EffectiveInstruction = InstructionManifest["instructions"][number] & {
  verbatimContent: string;
  path: string;
};

export type ScopeTrie = {
  snapshotId: SnapshotId;
  filesByScope: ReadonlyMap<string, DiscoveredContextFile>;
  ordered: readonly DiscoveredContextFile[];
  worktreeShadows: ContextDiscoveryResult["worktreeShadows"];
};

export type CoverageResult =
  | { ok: true }
  | {
      ok: false;
      code: typeof MODEL_CONTEXT_MISSING;
      missingInstructionIds: readonly string[];
    };

export type CapabilityPolicy = {
  hostShell: boolean;
  secretEgress: boolean;
  network: boolean;
  promotion: boolean;
  signing: boolean;
  deployment: boolean;
};

const EMPTY_POLICY: CapabilityPolicy = {
  hostShell: false,
  secretEgress: false,
  network: false,
  promotion: false,
  signing: false,
  deployment: false,
};

export function buildScopeTrie(
  discovery: ContextDiscoveryResult,
  snapshotId: SnapshotId,
): ScopeTrie {
  const filesByScope = new Map<string, DiscoveredContextFile>();
  for (const file of discovery.files) {
    filesByScope.set(file.scope, file);
  }
  return {
    snapshotId,
    filesByScope,
    ordered: discovery.files,
    worktreeShadows: discovery.worktreeShadows,
  };
}

export function effectiveChainForPath(trie: ScopeTrie, touchedPath: string): EffectiveInstruction[] {
  const skip = shadowedPathsFor(trie, touchedPath);
  const chain: EffectiveInstruction[] = [];
  for (const file of trie.ordered) {
    if (file.path.startsWith("global:") || file.sourceRef.origin === "artifact") {
      chain.push(toEffective(file));
      continue;
    }
    if (skip.has(file.path)) {
      continue;
    }
    if (scopeApplies(file.scope, touchedPath)) {
      chain.push(toEffective(file));
    }
  }
  return chain;
}

export function checkCompiledContextCoverage(input: {
  trie: ScopeTrie;
  touchedPaths: readonly string[];
  compiledInstructionIds: ReadonlySet<string>;
}): CoverageResult {
  const missing = new Set<string>();
  for (const path of input.touchedPaths) {
    for (const instruction of effectiveChainForPath(input.trie, path)) {
      if (!input.compiledInstructionIds.has(instruction.id)) {
        missing.add(instruction.id);
      }
    }
  }
  if (missing.size === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    code: MODEL_CONTEXT_MISSING,
    missingInstructionIds: [...missing].sort(),
  };
}

export function buildInstructionManifest(trie: ScopeTrie): InstructionManifest {
  const manifest: InstructionManifest = {
    schemaVersion: 1,
    snapshotId: trie.snapshotId,
    instructions: trie.ordered.map((file) => instructionDescriptor(file)),
  };
  if (!INSTRUCTION_MANIFEST.Check(manifest)) {
    throw new Error("instruction manifest schema invalid");
  }
  return manifest;
}

export function resolveCapabilityPolicy(chain: readonly EffectiveInstruction[]): CapabilityPolicy {
  const policy: CapabilityPolicy = { ...EMPTY_POLICY };
  for (const instruction of chain) {
    const parsed = parseYamlFrontmatter(instruction.verbatimContent);
    if ("error" in parsed || !parsed.hasFrontmatter) {
      continue;
    }
    applyCapabilityMap(policy, yamlMap(parsed.fields.allow), instruction.trust, "allow");
    applyCapabilityMap(policy, yamlMap(parsed.fields.deny), instruction.trust, "deny");
  }
  return policy;
}

export function mandatorySkillIdsFromInstructions(
  chain: readonly EffectiveInstruction[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const instruction of chain) {
    if (
      instruction.trust !== "platform" &&
      instruction.trust !== "user" &&
      instruction.trust !== "trusted-project"
    ) {
      continue;
    }
    const parsed = parseYamlFrontmatter(instruction.verbatimContent);
    if ("error" in parsed || !parsed.hasFrontmatter) {
      continue;
    }
    const listed = [
      ...yamlStringList(parsed.fields["mandatory-skills"]),
      ...yamlStringList(parsed.fields.mandatorySkills),
    ];
    for (const id of listed) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function toEffective(file: DiscoveredContextFile): EffectiveInstruction {
  return {
    ...instructionDescriptor(file),
    verbatimContent: file.body,
    path: file.path,
  };
}

function scopeApplies(scope: string, touchedPath: string): boolean {
  if (scope === ".") {
    return true;
  }
  const directory = touchedPath.includes("/") ? posixDirname(touchedPath) : ".";
  return ancestorScopes(directory).includes(scope) || ancestorScopes(touchedPath).includes(scope);
}

function shadowedPathsFor(trie: ScopeTrie, touchedPath: string): Set<string> {
  const skip = new Set<string>();
  let match: (typeof trie.worktreeShadows)[number] | undefined;
  for (const shadow of trie.worktreeShadows) {
    if (touchedPath === shadow.worktreeRoot || touchedPath.startsWith(`${shadow.worktreeRoot}/`)) {
      if (match === undefined || shadow.worktreeRoot.length > match.worktreeRoot.length) {
        match = shadow;
      }
    }
  }
  if (match !== undefined) {
    skip.add(match.shadowedPath);
  }
  return skip;
}

function applyCapabilityMap(
  policy: CapabilityPolicy,
  fields: ReturnType<typeof yamlMap>,
  trust: TrustLabel,
  op: "allow" | "deny",
): void {
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const key = capabilityKey(rawKey);
    if (key === undefined || rawValue !== true) {
      continue;
    }
    if (op === "deny") {
      policy[key] = false;
      continue;
    }
    if (trust === "platform" || trust === "user") {
      policy[key] = true;
    }
  }
}

function capabilityKey(raw: string): keyof CapabilityPolicy | undefined {
  const key = raw.trim().toLowerCase().replaceAll("_", "-");
  switch (key) {
    case "host-shell":
    case "hostshell":
      return "hostShell";
    case "secret-egress":
    case "secretegress":
      return "secretEgress";
    case "network":
      return "network";
    case "promotion":
      return "promotion";
    case "signing":
      return "signing";
    case "deployment":
      return "deployment";
    default:
      return undefined;
  }
}
