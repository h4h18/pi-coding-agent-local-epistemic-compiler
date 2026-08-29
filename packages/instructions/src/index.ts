export const packageName = "@pi-hec/instructions";

export {
  CONTEXT_FILE_CANDIDATES,
  MODEL_CONTEXT_MISSING,
  artifactSourceRef,
  asUtf8,
  discoverContextFiles,
  instructionDescriptor,
  nfc,
  nodesFromSnapshotEntries,
  parseYamlFrontmatter,
  quoteDigestForBytes,
  repositorySourceRef,
} from "./context-discovery.js";
export type {
  ContextDiscoveryInput,
  ContextDiscoveryResult,
  ContextFileName,
  DiscoveredContextFile,
  ExternalInstructionSource,
  FrontmatterDocument,
  FrontmatterResult,
  InstructionCollision,
  SnapshotNode,
  TrustLabel,
  WorktreeShadow,
  YamlMap,
  YamlValue,
} from "./context-discovery.js";

export {
  buildInstructionManifest,
  buildScopeTrie,
  checkCompiledContextCoverage,
  effectiveChainForPath,
  mandatorySkillIdsFromInstructions,
  resolveCapabilityPolicy,
} from "./scope-trie.js";
export type {
  CapabilityPolicy,
  CoverageResult,
  EffectiveInstruction,
  ScopeTrie,
} from "./scope-trie.js";

export { discoverSkills, skillAliasKey } from "./skill-discovery.js";
export type {
  DiscoveredSkill,
  ExternalSkillSource,
  SkillDiscoveryInput,
  SkillDiscoveryResult,
} from "./skill-discovery.js";

export { resolveSkills } from "./skill-resolver.js";
export type { SkillResolverInput, SkillResolverResult } from "./skill-resolver.js";
