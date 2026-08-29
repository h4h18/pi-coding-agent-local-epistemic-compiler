export const packageName = "@pi-hec/evidence";

export {
  FUSION_EXTRACTOR_ID,
  FUSION_EXTRACTOR_VERSION,
  GraphInvariantError,
  applyEvidenceDelta,
  artifactSourceRef,
  asEvidenceId,
  asObjectDigest,
  asSnapshotId,
  assertEvidenceGraph,
  compareUtf8,
  createEvidenceEdge,
  createEvidenceNode,
  defaultTrust,
  emptyEvidenceGraph,
  estimatedTokensFor,
  evidenceGraphDigest,
  evidenceKindForUnitKind,
  identityKeyForUnit,
  identityProvenanceIdentities,
  independenceGroupFor,
  isHistoricalNode,
  isVolatileExtractor,
  makeProvenance,
  mergeEvidence,
  mergeEvidenceNodes,
  mergeProvenance,
  nodeIdentityId,
  provenanceDedupeKey,
  provenanceIdentity,
  repositorySourceRef,
  unitToNode,
} from "./graph.js";
export type { EvidenceDelta, EvidenceEdgeDraft, EvidenceNodeDraft, IndexUnitRow, RelationName } from "./graph.js";

export {
  FUSION_CHANNEL_WEIGHTS,
  FUSION_WEIGHTS_DIGEST,
  FUSION_WEIGHTS_VERSION,
  RETRIEVAL_CHANNEL_IDS,
  RRF_K,
  attachFusionProvenance,
  fuseRankings,
  rrfContribution,
} from "./fusion.js";
export type {
  ChannelRanking,
  FusedCandidate,
  FusionResult,
  RankedCandidate,
  RerankerFeatures,
  RetrievalChannelId,
} from "./fusion.js";

export {
  astFingerprintFor,
  dedupeEvidence,
  dedupeSubjects,
  fqSignatureFor,
  normalizeCloneText,
  normalizedTextDigest,
  overloadKeyFor,
  remapEdges,
  subjectFromNode,
} from "./dedupe.js";
export type { DedupeResult, DedupeSubject } from "./dedupe.js";

export {
  RetrievalFrontier,
  actionCanonicalDigest,
  canonicalizeFilters,
  createRetrievalAction,
  normalizeQuery,
} from "./frontier.js";
export type { ExpandableChannel, FrontierDecision } from "./frontier.js";

export {
  collectDeltas,
  createRetrievalChannels,
  ingestLocalEvidenceProposal,
  openIndexDatabase,
  retrieveAndFuse,
  unitToSubject,
} from "./claims.js";
export type {
  ChannelProbe,
  EvidenceChannelHost,
  LocalEvidenceProposal,
  RetrievalChannel,
  RetrievalIntent,
  RetrieveAndFuseResult,
} from "./claims.js";
