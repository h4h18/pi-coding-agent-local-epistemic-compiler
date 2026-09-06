import { Compile } from "typebox/compile";
import { type Static } from "typebox";
import {
  EvidenceDeltaSchema,
  EvidenceGraphSchema,
  canonicalizeRfc8785,
  isEvidenceId,
  isObjectDigest,
  isSnapshotId,
  objectDigestFromBytes,
  taggedHash,
  sha256Utf8,
  type Digest,
  type EvidenceEdge,
  type EvidenceGraph,
  type EvidenceId,
  type EvidenceNode,
  type EvidenceNodeKind,
  type EvidenceRelation,
  type JsonValue,
  type ObjectDigest,
  type Provenance,
  type SnapshotId,
  type SourceRange,
  type SourceRef,
  type TrustVector,
} from "@pi-hec/contracts";
import { evidenceIdFromNode, sha256HexToCrockford32 } from "@pi-hec/repository";

export type EvidenceDelta = Static<typeof EvidenceDeltaSchema>;

export const FUSION_EXTRACTOR_ID = "pi-hec-rrf-fusion/v1";
export const FUSION_EXTRACTOR_VERSION = "fusion-weights/v1";

const GRAPH = Compile(EvidenceGraphSchema);
const DELTA = Compile(EvidenceDeltaSchema);

export class GraphInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphInvariantError";
  }
}

export function compareUtf8(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function isVolatileExtractor(extractorId: string): boolean {
  return extractorId === FUSION_EXTRACTOR_ID;
}

export function provenanceIdentity(provenance: Provenance): string {
  if (isVolatileExtractor(provenance.extractorId)) {
    return canonicalizeRfc8785({
      extractorId: provenance.extractorId,
      extractorVersion: provenance.extractorVersion,
      contentDigest: provenance.contentDigest,
    });
  }
  const source = provenance.source;
  if (source.origin === "repository") {
    if (source.sourceKind === "git-history") {
      const commit = source.path.replace(/^\.git\/commits\//, "").replace(/\.diff$/, "");
      return `git:${commit}`;
    }
    return `repo:${source.path}`;
  }
  if (source.origin === "external") {
    return canonicalizeRfc8785({
      url: source.url,
      artifactObjectDigest: source.artifactObjectDigest,
      quoteDigest: source.quoteDigest,
      extractorId: provenance.extractorId,
      extractorVersion: provenance.extractorVersion,
    });
  }
  return canonicalizeRfc8785({
    artifactObjectDigest: source.artifactObjectDigest,
    quoteDigest: source.quoteDigest,
    extractorId: provenance.extractorId,
    extractorVersion: provenance.extractorVersion,
  });
}

export function identityProvenanceIdentities(provenance: readonly Provenance[]): string[] {
  const identities = provenance
    .filter((item) => !isVolatileExtractor(item.extractorId))
    .map(provenanceIdentity);
  return [...new Set(identities)].sort(compareUtf8);
}

export function provenanceDedupeKey(provenance: Provenance): string {
  const body: { [key: string]: JsonValue } = {
    extractorId: provenance.extractorId,
    extractorVersion: provenance.extractorVersion,
    contentDigest: provenance.contentDigest,
    source: sourceAsJson(provenance.source),
  };
  if (provenance.queryId !== undefined) {
    body.queryId = provenance.queryId;
  }
  return canonicalizeRfc8785(body);
}

function sourceAsJson(source: SourceRef): JsonValue {
  return JSON.parse(canonicalizeRfc8785(source)) as JsonValue;
}

export function mergeProvenance(
  left: readonly Provenance[],
  right: readonly Provenance[],
): Provenance[] {
  const seen = new Set<string>();
  const merged: Provenance[] = [];
  for (const item of [...left, ...right]) {
    const key = provenanceDedupeKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }
  merged.sort((a, b) => compareUtf8(provenanceDedupeKey(a), provenanceDedupeKey(b)));
  return merged;
}

export function asObjectDigest(value: string): ObjectDigest {
  if (!isObjectDigest(value)) {
    throw new GraphInvariantError(`invalid object digest ${value}`);
  }
  return value;
}

export function asEvidenceId(value: string): EvidenceId {
  if (!isEvidenceId(value)) {
    throw new GraphInvariantError(`invalid evidence id ${value}`);
  }
  return value;
}

export function asEvidenceIds(values: readonly string[]): EvidenceId[] {
  return values.map(asEvidenceId);
}

export function asSnapshotId(value: string): SnapshotId {
  if (!isSnapshotId(value)) {
    throw new GraphInvariantError(`invalid snapshot id ${value}`);
  }
  return value;
}

export type EvidenceNodeDraft = Omit<EvidenceNode, "id"> & { snapshotId: SnapshotId };

export type IdentifiedEvidenceNode = EvidenceNode & { id: EvidenceId };

export function createEvidenceNode(draft: EvidenceNodeDraft): IdentifiedEvidenceNode {
  const provenanceIdentities = identityProvenanceIdentities(draft.provenance);
  const id = evidenceIdFromNode({
    snapshotId: draft.snapshotId,
    kind: draft.kind,
    identityKey: draft.identityKey,
    provenanceIdentities,
    ...(draft.contentObjectDigest !== undefined
      ? { contentObjectDigest: asObjectDigest(draft.contentObjectDigest) }
      : {}),
  });
  return {
    id,
    kind: draft.kind,
    identityKey: draft.identityKey,
    authorship: draft.authorship,
    label: draft.label,
    status: draft.status,
    trust: draft.trust,
    provenance: draft.provenance,
    estimatedTokens: draft.estimatedTokens,
    ...(draft.contentObjectDigest !== undefined
      ? { contentObjectDigest: draft.contentObjectDigest }
      : {}),
  };
}

export type EvidenceEdgeDraft = Omit<EvidenceEdge, "id">;

export function createEvidenceEdge(draft: EvidenceEdgeDraft): EvidenceEdge {
  const provenanceIdentities = identityProvenanceIdentities(draft.provenance);
  const digest = taggedHash("evidence-edge", 1, {
    from: draft.from,
    to: draft.to,
    relation: draft.relation,
    polarity: draft.polarity,
    provenanceIdentities,
  } satisfies JsonValue);
  return {
    ...draft,
    id: `edge_${sha256HexToCrockford32(digest.slice("sha256:".length))}`,
  };
}

export function emptyEvidenceGraph(snapshotId: SnapshotId): EvidenceGraph {
  return { schemaVersion: 1, snapshotId, nodes: [], edges: [] };
}

export function evidenceGraphDigest(graph: EvidenceGraph): ObjectDigest {
  return objectDigestFromBytes(
    Buffer.from(
      canonicalizeRfc8785({
        schemaVersion: graph.schemaVersion,
        snapshotId: graph.snapshotId,
        nodeIds: graph.nodes.map((node) => node.id).sort(compareUtf8),
        edgeIds: graph.edges.map((edge) => edge.id).sort(compareUtf8),
        provenanceIdentities: graph.nodes
          .flatMap((node) => identityProvenanceIdentities(node.provenance))
          .sort(compareUtf8),
      }),
      "utf8",
    ),
  );
}

export function nodeIdentityId(snapshotId: SnapshotId, node: EvidenceNode): EvidenceId {
  return evidenceIdFromNode({
    snapshotId,
    kind: node.kind,
    identityKey: node.identityKey,
    provenanceIdentities: identityProvenanceIdentities(node.provenance),
    ...(node.contentObjectDigest !== undefined
      ? { contentObjectDigest: asObjectDigest(node.contentObjectDigest) }
      : {}),
  });
}

export function isHistoricalNode(node: EvidenceNode): boolean {
  if (node.kind === "commit" || node.kind === "diff-hunk") {
    return true;
  }
  return node.provenance.some(
    (item) => item.source.origin === "repository" && item.source.sourceKind === "git-history",
  );
}

function worseStatus(
  left: EvidenceNode["status"],
  right: EvidenceNode["status"],
): EvidenceNode["status"] {
  const rank: Record<EvidenceNode["status"], number> = {
    verified: 0,
    probable: 1,
    unknown: 2,
    conflicted: 3,
    invalidated: 4,
  };
  return rank[left] >= rank[right] ? left : right;
}

function mergeAuthorship(
  left: EvidenceNode["authorship"],
  right: EvidenceNode["authorship"],
): EvidenceNode["authorship"] {
  if (left === "CLOUD_MODEL" || right === "CLOUD_MODEL") {
    return "CLOUD_MODEL";
  }
  if (left === "LOCAL_MODEL" || right === "LOCAL_MODEL") {
    return "LOCAL_MODEL";
  }
  if (left === "USER" || right === "USER") {
    return "USER";
  }
  return "DETERMINISTIC";
}

function mergeTrustVector(left: TrustVector, right: TrustVector): TrustVector {
  if (left.independenceGroup !== right.independenceGroup) {
    return left;
  }
  return {
    authority: left.authority,
    directness: left.directness,
    extractorReliability: Math.min(left.extractorReliability, right.extractorReliability),
    freshness: Math.min(left.freshness, right.freshness),
    independenceGroup: left.independenceGroup,
    adversarialRisk: Math.max(left.adversarialRisk, right.adversarialRisk),
  };
}

export function mergeEvidenceNodes(left: EvidenceNode, right: EvidenceNode): EvidenceNode {
  if (left.id !== right.id) {
    throw new GraphInvariantError("cannot merge evidence nodes with distinct identities");
  }
  if (left.kind !== right.kind || left.identityKey !== right.identityKey) {
    throw new GraphInvariantError("identity-bearing fields disagree for the same evidence id");
  }
  const leftHistorical = isHistoricalNode(left);
  const rightHistorical = isHistoricalNode(right);
  if (leftHistorical !== rightHistorical) {
    throw new GraphInvariantError("historical and current evidence cannot collapse");
  }
  const independenceConflict = left.trust.independenceGroup !== right.trust.independenceGroup;
  const authorship = mergeAuthorship(left.authorship, right.authorship);
  if (
    (left.authorship === "DETERMINISTIC" || left.authorship === "USER") &&
    (right.authorship === "LOCAL_MODEL" || right.authorship === "CLOUD_MODEL")
  ) {
    if (authorship === "DETERMINISTIC") {
      throw new GraphInvariantError("local or cloud authorship cannot transmute to DETERMINISTIC");
    }
  }
  return {
    id: left.id,
    kind: left.kind,
    identityKey: left.identityKey,
    authorship,
    label: compareUtf8(left.label, right.label) <= 0 ? left.label : right.label,
    status: independenceConflict
      ? "conflicted"
      : worseStatus(left.status, right.status),
    trust: mergeTrustVector(left.trust, right.trust),
    provenance: mergeProvenance(left.provenance, right.provenance),
    estimatedTokens: Math.max(left.estimatedTokens, right.estimatedTokens),
    ...(left.contentObjectDigest !== undefined
      ? { contentObjectDigest: left.contentObjectDigest }
      : right.contentObjectDigest !== undefined
        ? { contentObjectDigest: right.contentObjectDigest }
        : {}),
  };
}

function mergeEvidenceEdges(left: EvidenceEdge, right: EvidenceEdge): EvidenceEdge {
  if (left.id !== right.id) {
    throw new GraphInvariantError("cannot merge evidence edges with distinct identities");
  }
  return {
    ...left,
    confidence: Math.max(left.confidence, right.confidence),
    provenance: mergeProvenance(left.provenance, right.provenance),
  };
}

export function mergeEvidence(
  graph: EvidenceGraph,
  nodes: readonly EvidenceNode[],
  edges: readonly EvidenceEdge[],
): EvidenceGraph {
  const nodeMap = new Map<string, EvidenceNode>();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
  }
  for (const node of nodes) {
    const existing = nodeMap.get(node.id);
    nodeMap.set(node.id, existing === undefined ? node : mergeEvidenceNodes(existing, node));
  }
  const edgeMap = new Map<string, EvidenceEdge>();
  for (const edge of graph.edges) {
    edgeMap.set(edge.id, edge);
  }
  for (const edge of edges) {
    const existing = edgeMap.get(edge.id);
    edgeMap.set(edge.id, existing === undefined ? edge : mergeEvidenceEdges(existing, edge));
  }
  const merged: EvidenceGraph = {
    schemaVersion: 1,
    snapshotId: graph.snapshotId,
    nodes: [...nodeMap.values()].sort((left, right) => compareUtf8(left.id, right.id)),
    edges: [...edgeMap.values()].sort((left, right) => compareUtf8(left.id, right.id)),
  };
  assertEvidenceGraph(merged);
  return merged;
}

export function applyEvidenceDelta(graph: EvidenceGraph, delta: EvidenceDelta): EvidenceGraph {
  if (!DELTA.Check(delta)) {
    throw new GraphInvariantError("evidence delta failed schema validation");
  }
  if (delta.baseEvidenceGraphObjectDigest !== evidenceGraphDigest(graph)) {
    throw new GraphInvariantError("evidence delta base digest does not match graph");
  }
  return mergeEvidence(graph, delta.nodes, delta.edges);
}

export function assertEvidenceGraph(graph: EvidenceGraph): void {
  if (!GRAPH.Check(graph)) {
    throw new GraphInvariantError("evidence graph failed schema validation");
  }
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) {
      throw new GraphInvariantError(`duplicate evidence node id ${node.id}`);
    }
    nodeIds.add(node.id);
    if (node.provenance.length === 0) {
      throw new GraphInvariantError(`evidence node ${node.id} dropped provenance`);
    }
    const expected = nodeIdentityId(asSnapshotId(graph.snapshotId), node);
    if (expected !== node.id) {
      throw new GraphInvariantError(`evidence node id ${node.id} does not match identity hash`);
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      throw new GraphInvariantError(`duplicate evidence edge id ${edge.id}`);
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new GraphInvariantError(`evidence edge ${edge.id} references missing nodes`);
    }
    const expected = createEvidenceEdge({
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      polarity: edge.polarity,
      confidence: edge.confidence,
      provenance: edge.provenance,
    }).id;
    if (expected !== edge.id) {
      throw new GraphInvariantError(`evidence edge id ${edge.id} does not match identity hash`);
    }
    if (edge.provenance.length === 0) {
      throw new GraphInvariantError(`evidence edge ${edge.id} dropped provenance`);
    }
  }
}

export function estimatedTokensFor(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function independenceGroupFor(producer: string, blobDigest: string): string {
  const value = `${producer}:${blobDigest}`;
  return value.length <= 256 ? value : value.slice(0, 256);
}

export function repositorySourceRef(input: {
  snapshotId: SnapshotId;
  artifactObjectDigest: ObjectDigest;
  path: string;
  quoteDigest: Digest;
  sourceKind?: "repository" | "git-history" | "project-instruction";
  range?: SourceRange;
}): SourceRef {
  return {
    origin: "repository",
    sourceKind: input.sourceKind ?? "repository",
    snapshotId: input.snapshotId,
    artifactObjectDigest: input.artifactObjectDigest,
    path: input.path,
    range: input.range ?? { kind: "whole" },
    quoteDigest: input.quoteDigest,
  };
}

export function artifactSourceRef(input: {
  artifactObjectDigest: ObjectDigest;
  quoteDigest: Digest;
  sourceKind?: "user-task" | "platform-policy" | "runtime" | "model-output";
}): SourceRef {
  return {
    origin: "artifact",
    sourceKind: input.sourceKind ?? "runtime",
    artifactObjectDigest: input.artifactObjectDigest,
    range: { kind: "whole" },
    quoteDigest: input.quoteDigest,
  };
}

export function makeProvenance(input: {
  source: SourceRef;
  extractorId: string;
  extractorVersion: string;
  observedAt: string;
  contentDigest: Digest;
  queryId?: string;
}): Provenance {
  return {
    source: input.source,
    extractorId: input.extractorId,
    extractorVersion: input.extractorVersion,
    observedAt: input.observedAt,
    contentDigest: input.contentDigest,
    ...(input.queryId !== undefined ? { queryId: input.queryId } : {}),
  };
}

export function defaultTrust(input: {
  independenceGroup: string;
  authority?: number;
  directness?: TrustVector["directness"];
  extractorReliability?: number;
  freshness?: number;
  adversarialRisk?: number;
}): TrustVector {
  return {
    authority: input.authority ?? 0.8,
    directness: input.directness ?? "static-derived",
    extractorReliability: input.extractorReliability ?? 0.9,
    freshness: input.freshness ?? 1,
    independenceGroup: input.independenceGroup,
    adversarialRisk: input.adversarialRisk ?? 0.1,
  };
}

export function evidenceKindForUnitKind(kind: string): EvidenceNodeKind {
  switch (kind) {
    case "function":
    case "method":
    case "class":
    case "top-level":
      return "symbol";
    case "test":
      return "test";
    case "schema-object":
      return "schema";
    case "config-block":
      return "build-config";
    case "commit":
      return "commit";
    case "diff":
      return "diff-hunk";
    case "directory":
      return "directory";
    case "file":
    case "markdown-section":
    case "fallback-window":
      return "code-region";
    default:
      throw new GraphInvariantError(`unhandled unit kind ${kind}`);
  }
}

export function identityKeyForUnit(input: {
  kind: string;
  path: string;
  byteStart: number;
  byteEnd: number;
  symbolId: string;
}): string {
  if (input.kind === "diff") {
    return `diff:${input.symbolId}`.slice(0, 1024);
  }
  if (input.kind === "commit") {
    return `commit:${input.symbolId}`.slice(0, 1024);
  }
  return `${input.kind}:${input.path}:${String(input.byteStart)}:${String(input.byteEnd)}:${input.symbolId}`.slice(
    0,
    1024,
  );
}

export type RelationName = EvidenceRelation;

export type IndexUnitRow = {
  evidenceId: EvidenceId;
  path: string;
  kind: string;
  symbolId: string;
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
  contentDigest: string;
  snapshotId: string;
  text: string;
  producer: string;
  category: string;
};

function rangeFor(row: IndexUnitRow): SourceRange {
  if (row.byteEnd > row.byteStart) {
    return {
      kind: "bytes",
      byteStart: row.byteStart,
      byteEnd: row.byteEnd,
      displayLines: { startLine: Math.max(1, row.lineStart), endLine: Math.max(1, row.lineEnd) },
    };
  }
  return { kind: "whole" };
}

function sourceKindFor(row: IndexUnitRow): "repository" | "git-history" | "project-instruction" {
  if (row.kind === "commit" || row.kind === "diff" || row.path.startsWith(".git/")) {
    return "git-history";
  }
  return row.category === "instruction" ? "project-instruction" : "repository";
}

export function unitToNode(row: IndexUnitRow, extractorId: string, observedAt: string): EvidenceNode {
  const quoteDigest = sha256Utf8(row.text);
  const blob = asObjectDigest(row.contentDigest);
  const historical = sourceKindFor(row) === "git-history";
  return createEvidenceNode({
    snapshotId: asSnapshotId(row.snapshotId),
    kind: evidenceKindForUnitKind(row.kind),
    identityKey: identityKeyForUnit(row),
    authorship: "DETERMINISTIC",
    label: row.symbolId || row.path,
    contentObjectDigest: blob,
    status: "probable",
    trust: defaultTrust({
      independenceGroup: independenceGroupFor(row.producer, blob),
      authority: historical ? 0.7 : 0.85,
      directness: historical ? "observed" : "static-derived",
      freshness: historical ? 0.5 : 1,
      adversarialRisk: 0.05,
    }),
    provenance: [
      makeProvenance({
        source: repositorySourceRef({
          snapshotId: asSnapshotId(row.snapshotId),
          artifactObjectDigest: blob,
          path: row.path,
          quoteDigest,
          sourceKind: sourceKindFor(row),
          range: rangeFor(row),
        }),
        extractorId,
        extractorVersion: row.producer,
        observedAt,
        contentDigest: quoteDigest,
      }),
    ],
    estimatedTokens: estimatedTokensFor(row.text),
  });
}

