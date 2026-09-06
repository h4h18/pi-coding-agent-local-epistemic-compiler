import type {
  EvidenceId,
  GitHistoryManifest,
  ObjectDigest,
  SnapshotId,
  SnapshotManifest,
} from "@pi-hec/contracts";

export const INDEX_TOOLCHAIN = {
  id: "pi-hec-repository-index",
  version: "1",
  sqliteVec: "0.1.9",
  webTreeSitter: "0.26.13",
  embedder: "pi-hec-deterministic-embedder/v1",
  chunker: "pi-hec-structural-chunker/v1",
  ftsTokenizer: "unicode61",
  vectorDimensions: 64,
} as const;

export type UnitKind =
  | "function"
  | "method"
  | "class"
  | "top-level"
  | "config-block"
  | "test"
  | "markdown-section"
  | "schema-object"
  | "diff"
  | "commit"
  | "fallback-window"
  | "file"
  | "directory";

export type FileCategory =
  "source" | "test" | "docs" | "config" | "instruction" | "generated" | "binary" | "other";

export type IndexUnit = {
  evidenceId: EvidenceId;
  path: string;
  kind: UnitKind;
  parentHierarchy: readonly string[];
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
  contentDigest: ObjectDigest;
  language: string;
  symbolId: string;
  imports: readonly string[];
  exports: readonly string[];
  snapshotId: SnapshotId;
  text: string;
  producer: string;
  interfaceFingerprint: string;
};

export type IndexedFile = {
  path: string;
  entryType: "file" | "directory" | "symlink" | "submodule";
  contentDigest: string | undefined;
  size: number;
  language: string;
  isBinary: boolean;
  isGenerated: boolean;
  category: FileCategory;
  interfaceFingerprint: string;
};

export type GraphEdgeRecord = {
  fromId: EvidenceId;
  toId: EvidenceId;
  relation:
    | "CONTAINS"
    | "DEFINES"
    | "IMPORTS"
    | "REFERENCES"
    | "CHANGED_WITH"
    | "INTRODUCED_BY"
    | "APPLIES_TO";
  producer: string;
};

export type BlobGetter = (objectDigest: ObjectDigest) => Promise<Uint8Array>;

export type BlobPutter = (bytes: Uint8Array) => Promise<ObjectDigest>;

export type RebuildIndexInput = {
  dbPath: string;
  projectId: string;
  manifest: SnapshotManifest;
  getBlob: BlobGetter;
  gitHistory?: GitHistoryManifest;
  grammarWasm?: Readonly<Record<string, string>>;
};

export type RebuildIndexResult = {
  indexRevision: ObjectDigest;
  toolchainDigest: ObjectDigest;
  evidenceIds: readonly EvidenceId[];
  unitCount: number;
  fileCount: number;
  dbPath: string;
};

export type IncrementalUpdateInput = RebuildIndexInput & {
  previousManifest: SnapshotManifest;
};

export type SearchHit = {
  evidenceId: EvidenceId;
  path: string;
  symbolId: string;
  language: string;
  rank: number;
  snippet: string;
};
