export const packageName = "@pi-hec/repository";

export {
  MaterializeError,
  assertGitHistoryManifest,
  assertSnapshotEntry,
  materializeSnapshot,
  snapshotRootDigest,
  unicodeSimpleFoldTableDigest,
} from "./materialize-snapshot.js";
export type {
  MaterializeSnapshotInput,
  MaterializeSnapshotResult,
} from "./materialize-snapshot.js";

export { caseFoldKey, classifyRelativePath } from "./relative-path.js";
export type { ClassifyRelativePathOptions, RelativePathRejectCode } from "./relative-path.js";

export {
  CandidateMaterializeError,
  candidateTreeDigest,
  materializeCandidateTree,
} from "./candidate-materializer.js";
export type {
  CandidateDirectoryEntry,
  CandidateEntry,
  CandidateFileEntry,
  CandidateSubmoduleEntry,
  CandidateSymlinkEntry,
  MaterializeCandidateTreeInput,
  MaterializeCandidateTreeResult,
} from "./candidate-materializer.js";

export { INDEX_TOOLCHAIN } from "./ingestion/types.js";
export type {
  BlobGetter,
  BlobPutter,
  IncrementalUpdateInput,
  IndexUnit,
  RebuildIndexInput,
  RebuildIndexResult,
  SearchHit,
  UnitKind,
} from "./ingestion/types.js";
export { evidenceIdFromNode, sha256HexToCrockford32 } from "./ingestion/evidence-id.js";
export { rebuildSnapshotIndex, listEvidenceIds } from "./ingestion/rebuild.js";
export { incrementallyUpdateIndex, needsFullRebuild } from "./ingestion/incremental.js";
export { indexRevisionDigest, toolchainDigest } from "./ingestion/revision.js";
export { validateUntrustedIndex } from "./ingestion/scip.js";
export { chunkSource } from "./ingestion/chunker.js";
export { INDEX_LIMITS, LimitError, assertWithinBudget } from "./ingestion/limits.js";
export { searchBm25 } from "./fts/search.js";
export { searchVector } from "./vector/store.js";
export { embedText, EMBEDDER_ID, VECTOR_DIMENSIONS } from "./vector/embedder.js";
export {
  initTreeSitterRuntime,
  enrichWithTreeSitter,
  UnpinnedGrammarError,
} from "./graph/tree-sitter.js";
export { gitUnitsAndEdges } from "./git/history.js";
export { openIndexDatabase } from "./index-db.js";
export { FetchError } from "./external-fetcher/errors.js";
export { classifyIp, isForbiddenIp, canonicalPublicIp } from "./external-fetcher/ip-policy.js";
export { evaluateFetchUrl } from "./external-fetcher/url-policy.js";
export {
  fetchExternal,
  memoryBlobPutter,
  defaultResolveDns,
  defaultOpenTls,
} from "./external-fetcher/fetcher.js";
export { accumulateLimitedWire } from "./external-fetcher/http.js";
export type { StreamLimits } from "./external-fetcher/http.js";
export type {
  ExternalFetchInput,
  ExternalFetchResult,
  FetchTransport,
  TlsSession,
} from "./external-fetcher/fetcher.js";
export type { HostPolicy } from "./external-fetcher/url-policy.js";
