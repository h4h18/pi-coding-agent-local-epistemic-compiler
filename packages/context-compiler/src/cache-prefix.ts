import { canonicalizeRfc8785, objectDigestFromBytes, type ObjectDigest } from "@pi-hec/contracts";

export const CACHE_PREFIX_ORDER = [
  "control-protocol",
  "tool-result-schemas",
  "platform-policy",
  "effective-instructions",
  "mandatory-skills",
  "repository-context-manifests",
  "task-specific-evidence",
] as const;

export type CachePrefixPartId = (typeof CACHE_PREFIX_ORDER)[number];

export type CachePrefixParts = {
  controlProtocol: string;
  toolResultSchemas: string;
  platformPolicy: string;
  effectiveInstructions: string;
  mandatorySkills: string;
  repositoryManifests: string;
  taskSpecificEvidence: string;
};

export type CacheIdentityInput = {
  projectId: string;
  controlProtocolDigest: ObjectDigest;
  toolResultSchemasDigest: ObjectDigest;
  platformPolicyDigest: ObjectDigest;
  effectiveInstructionsDigest: ObjectDigest;
  mandatorySkillsDigest: ObjectDigest;
  repositoryManifestsDigest: ObjectDigest;
  taskSpecificEvidenceDigest: ObjectDigest;
};

function digestText(text: string): ObjectDigest {
  return objectDigestFromBytes(Buffer.from(text, "utf8"));
}

export function partText(parts: CachePrefixParts, id: CachePrefixPartId): string {
  switch (id) {
    case "control-protocol":
      return parts.controlProtocol;
    case "tool-result-schemas":
      return parts.toolResultSchemas;
    case "platform-policy":
      return parts.platformPolicy;
    case "effective-instructions":
      return parts.effectiveInstructions;
    case "mandatory-skills":
      return parts.mandatorySkills;
    case "repository-context-manifests":
      return parts.repositoryManifests;
    case "task-specific-evidence":
      return parts.taskSpecificEvidence;
    default: {
      const exhaustive: never = id;
      throw new Error(`unhandled cache prefix part ${String(exhaustive)}`);
    }
  }
}

export function buildStableCachePrefix(parts: CachePrefixParts): string {
  return CACHE_PREFIX_ORDER.map((id) => `<<${id}>>\n${partText(parts, id)}`).join("\n");
}

export function cacheIdentityFromParts(projectId: string, parts: CachePrefixParts): CacheIdentityInput {
  return {
    projectId,
    controlProtocolDigest: digestText(parts.controlProtocol),
    toolResultSchemasDigest: digestText(parts.toolResultSchemas),
    platformPolicyDigest: digestText(parts.platformPolicy),
    effectiveInstructionsDigest: digestText(parts.effectiveInstructions),
    mandatorySkillsDigest: digestText(parts.mandatorySkills),
    repositoryManifestsDigest: digestText(parts.repositoryManifests),
    taskSpecificEvidenceDigest: digestText(parts.taskSpecificEvidence),
  };
}

export function cacheIdentityDigest(identity: CacheIdentityInput): ObjectDigest {
  return objectDigestFromBytes(Buffer.from(canonicalizeRfc8785(identity), "utf8"));
}

export function prefixContainsRunId(prefix: string, runId: string): boolean {
  return prefix.includes(runId);
}
