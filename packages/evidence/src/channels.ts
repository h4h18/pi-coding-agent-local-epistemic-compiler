import { Compile } from "typebox/compile";
import {
  EvidenceDeltaSchema,
  LocalEvidenceProposalSchema,
  RetrievalIntentSchema,
  canonicalizeRfc8785,
  objectDigestFromBytes,
  sha256Utf8,
  type EvidenceEdge,
  type EvidenceGraph,
  type EvidenceId,
  type EvidenceNode,
  type EvidenceRelation,
  type LocalEvidenceProposal,
  type ObjectDigest,
  type RetrievalAction,
  type RetrievalIntent,
  type SnapshotId,
  type SourceRef,
} from "@pi-hec/contracts";
import {
  openIndexDatabase,
  searchBm25,
  searchVector,
  type ExternalFetchInput,
  type ExternalFetchResult,
  type SearchHit,
} from "@pi-hec/repository";
import {
  artifactSourceRef,
  asEvidenceId,
  asEvidenceIds,
  asObjectDigest,
  compareUtf8,
  createEvidenceEdge,
  createEvidenceNode,
  defaultTrust,
  emptyEvidenceGraph,
  estimatedTokensFor,
  evidenceGraphDigest,
  independenceGroupFor,
  makeProvenance,
  unitToNode,
  type EvidenceDelta,
} from "./graph.js";
import {
  astFingerprintFor,
  fqSignatureFor,
  normalizedTextDigest,
  overloadKeyFor,
  type DedupeSubject,
} from "./dedupe.js";
import {
  FUSION_CHANNEL_WEIGHTS,
  fuseRankings,
  type ChannelRanking,
  type RankedCandidate,
  type RetrievalChannelId,
} from "./fusion.js";

export type { LocalEvidenceProposal, RetrievalIntent };

const INTENT = Compile(RetrievalIntentSchema);
const DELTA = Compile(EvidenceDeltaSchema);
const PROPOSAL = Compile(LocalEvidenceProposalSchema);

type IndexDb = ReturnType<typeof openIndexDatabase>;

export type ChannelProbe = "available" | "degraded" | "unavailable";
export type EvidenceChannelHost = {
  snapshotId: SnapshotId;
  db?: IndexDb;
  nowIso: () => string;
  runId?: RetrievalIntent["runId"];
  graph?: EvidenceGraph;
  localProposals?: readonly LocalEvidenceProposal[];
  fetchExternal?: (input: ExternalFetchInput) => Promise<ExternalFetchResult>;
  putBlob?: (bytes: Uint8Array) => Promise<ObjectDigest>;
};
export interface RetrievalChannel {
  readonly id: RetrievalChannelId;
  readonly versionObjectDigest: ObjectDigest;
  probe(snapshotId: SnapshotId): Promise<ChannelProbe>;
  seed(intent: RetrievalIntent, signal: AbortSignal): AsyncIterable<EvidenceDelta>;
  expand(action: RetrievalAction, signal: AbortSignal): AsyncIterable<EvidenceDelta>;
}

export type UnitRow = {
  evidenceId: EvidenceId; path: string; kind: string; symbolId: string; parentHierarchy: string;
  byteStart: number; byteEnd: number; lineStart: number; lineEnd: number; contentDigest: ObjectDigest;
  language: string; snapshotId: SnapshotId; text: string; producer: string; interfaceFingerprint: string;
  category: string; isGenerated: number;
};
type EdgeRow = { fromId: EvidenceId; toId: EvidenceId; relation: EvidenceRelation; producer: string };

const UNIT_SELECT = `SELECT units.evidence_id AS evidenceId, units.path AS path, units.kind AS kind, units.symbol_id AS symbolId, units.parent_hierarchy AS parentHierarchy, units.byte_start AS byteStart, units.byte_end AS byteEnd, units.line_start AS lineStart, units.line_end AS lineEnd, units.content_digest AS contentDigest, units.language AS language, units.snapshot_id AS snapshotId, units.text AS text, units.producer AS producer, units.interface_fingerprint AS interfaceFingerprint, COALESCE(files.category, 'other') AS category, COALESCE(files.is_generated, 0) AS isGenerated FROM units LEFT JOIN files ON files.path = units.path`;

export function throwIfAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    return Promise.reject(reason instanceof Error ? reason : new Error("aborted"));
  }
  return Promise.resolve();
}

function channelVersionDigest(id: RetrievalChannelId): ObjectDigest {
  return objectDigestFromBytes(
    Buffer.from(canonicalizeRfc8785({ channelId: id, version: 1, weights: FUSION_CHANNEL_WEIGHTS[id] }), "utf8"),
  );
}

export function hostGraph(host: EvidenceChannelHost): EvidenceGraph {
  return host.graph ?? emptyEvidenceGraph(host.snapshotId);
}

export function hostGraphDigest(host: EvidenceChannelHost): ObjectDigest {
  return evidenceGraphDigest(hostGraph(host));
}

function queryUnits(db: IndexDb, sql: string, params: readonly unknown[]): UnitRow[] {
  return db.prepare(`${UNIT_SELECT} ${sql}`).all(...params) as UnitRow[];
}

export function queryUnitsByPathBytes(
  db: IndexDb,
  path: string,
  byteStart: number,
  byteEnd: number,
): UnitRow[] {
  return queryUnits(db, "WHERE units.path = ? AND units.byte_start = ? AND units.byte_end = ?", [
    path,
    byteStart,
    byteEnd,
  ]);
}

export function queryUnitsByEvidenceIds(db: IndexDb, ids: readonly string[]): UnitRow[] {
  const rows: UnitRow[] = [];
  const chunkSize = 64;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    if (chunk.length === 0) {
      continue;
    }
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(...queryUnits(db, `WHERE units.evidence_id IN (${placeholders})`, chunk));
  }
  return rows;
}

function queryEdges(db: IndexDb, evidenceIds: readonly string[]): EdgeRow[] {
  if (evidenceIds.length === 0) {
    return [];
  }
  const rows: EdgeRow[] = [];
  const stmt = db.prepare(
    `SELECT from_id AS fromId, to_id AS toId, relation AS relation, producer AS producer
     FROM graph_edges WHERE from_id = ? OR to_id = ?`,
  );
  const seen = new Set<string>();
  for (const id of evidenceIds) {
    for (const row of stmt.all(id, id) as EdgeRow[]) {
      const key = `${row.fromId}\0${row.toId}\0${row.relation}\0${row.producer}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

export function unitToSubject(row: UnitRow, node: EvidenceNode): DedupeSubject {
  return {
    node,
    producer: row.producer,
    blobDigest: row.contentDigest,
    scipSymbolId: row.symbolId,
    fqSignature: fqSignatureFor(row.symbolId, row.interfaceFingerprint),
    astFingerprint: astFingerprintFor({
      kind: row.kind,
      language: row.language,
      symbolId: row.symbolId,
      text: row.text,
      parentHierarchy: row.parentHierarchy,
    }),
    path: row.path,
    byteStart: row.byteStart,
    byteEnd: row.byteEnd,
    generated: row.isGenerated === 1,
    overloadKey: overloadKeyFor(row.symbolId, row.interfaceFingerprint),
    normalizedTextDigest: normalizedTextDigest(row.text),
  };
}

function edgeFromRow(row: EdgeRow, observedAt: string, extractorId: string): EvidenceEdge {
  const digest = asObjectDigest(sha256Utf8(`${row.fromId}:${row.toId}:${row.relation}`));
  return createEvidenceEdge({
    from: asEvidenceId(row.fromId),
    to: asEvidenceId(row.toId),
    relation: row.relation,
    polarity: "positive",
    confidence: 0.8,
    provenance: [
      makeProvenance({
        source: artifactSourceRef({ artifactObjectDigest: digest, quoteDigest: digest }),
        extractorId,
        extractorVersion: row.producer,
        observedAt,
        contentDigest: digest,
      }),
    ],
  });
}

function capabilityNode(
  host: EvidenceChannelHost,
  channelId: RetrievalChannelId,
  probe: ChannelProbe,
): EvidenceNode {
  const digest = asObjectDigest(sha256Utf8(`channel:${channelId}:${probe}`));
  return createEvidenceNode({
    snapshotId: host.snapshotId,
    kind: "unknown",
    identityKey: `channel-capability:${channelId}:${probe}`,
    authorship: "DETERMINISTIC",
    label: `channel ${channelId} ${probe}`,
    status: probe === "available" ? "verified" : probe === "degraded" ? "probable" : "unknown",
    contentObjectDigest: digest,
    trust: defaultTrust({
      independenceGroup: independenceGroupFor(`channel:${channelId}`, digest),
      authority: probe === "unavailable" ? 0 : 0.4,
      directness: "observed",
      extractorReliability: probe === "available" ? 1 : 0.2,
      freshness: 1,
      adversarialRisk: 0,
    }),
    provenance: [
      makeProvenance({
        source: artifactSourceRef({ artifactObjectDigest: digest, quoteDigest: digest }),
        extractorId: `pi-hec-channel-${channelId}/v1`,
        extractorVersion: "capability/v1",
        observedAt: host.nowIso(),
        contentDigest: digest,
      }),
    ],
    estimatedTokens: 1,
  });
}

function candidatesFromRows(
  channelId: RetrievalChannelId,
  rows: readonly UnitRow[],
  extractorId: string,
  observedAt: string,
  db: IndexDb | undefined,
): { candidates: RankedCandidate[]; subjects: DedupeSubject[] } {
  const candidates: RankedCandidate[] = [];
  const subjects: DedupeSubject[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.evidenceId)) {
      continue;
    }
    seen.add(row.evidenceId);
    const node = unitToNode(row, extractorId, observedAt);
    const subject = unitToSubject(row, node);
    subjects.push(subject);
    const edgeRows = db === undefined ? [] : queryEdges(db, [row.evidenceId]);
    candidates.push({
      evidenceId: row.evidenceId,
      identityKey: node.identityKey,
      channelId,
      rank: candidates.length + 1,
      node,
      edges: edgeRows.map((edge) => edgeFromRow(edge, observedAt, extractorId)),
    });
  }
  return { candidates, subjects };
}

export function isCapabilityNode(node: EvidenceNode): boolean {
  return node.identityKey.startsWith("channel-capability:") || node.identityKey.startsWith("channel-failure:");
}

export function toDelta(
  host: EvidenceChannelHost,
  ranking: ChannelRanking,
  extraNodes: readonly EvidenceNode[],
  unresolved: readonly EvidenceId[],
): EvidenceDelta {
  const nodes = [...ranking.candidates.map((item) => item.node), ...extraNodes];
  const known = new Set([...hostGraph(host).nodes.map((node) => node.id), ...nodes.map((node) => node.id)]);
  const edges = ranking.candidates
    .flatMap((item) => [...item.edges])
    .filter((edge) => known.has(edge.from) && known.has(edge.to));
  const uniqueEdges = [...new Map(edges.map((edge) => [edge.id, edge])).values()].sort((left, right) =>
    compareUtf8(left.id, right.id),
  );
  const delta: EvidenceDelta = {
    schemaVersion: 1,
    baseEvidenceGraphObjectDigest: hostGraphDigest(host),
    nodes,
    edges: uniqueEdges,
    unresolvedClaimIds: [...unresolved],
    nextActions: [],
  };
  if (!DELTA.Check(delta)) {
    throw new Error(`channel ${ranking.channelId} produced an invalid evidence delta`);
  }
  return delta;
}

export function filterValue(filters: RetrievalAction["filters"], key: string): string | undefined {
  const value = filters[key];
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
}

function unitsByHints(
  db: IndexDb,
  query: string,
  hints: readonly string[],
  extraWhere: string,
  extraParams: readonly unknown[],
): UnitRow[] {
  const needles = [...hints, query].map((item) => item.trim()).filter((item) => item.length > 0);
  if (needles.length === 0) {
    return [];
  }
  const clauses = needles.map(() => "(INSTR(units.path, ?) > 0 OR INSTR(units.symbol_id, ?) > 0 OR INSTR(units.text, ?) > 0)");
  const params: unknown[] = needles.flatMap((needle) => [needle, needle, needle]);
  const hintSql = `(${clauses.join(" OR ")})`;
  const where = extraWhere === "" ? `WHERE ${hintSql}` : `WHERE (${hintSql}) AND (${extraWhere})`;
  return queryUnits(db, where, [...params, ...extraParams]);
}

function hitsToRows(db: IndexDb, hits: readonly SearchHit[]): UnitRow[] {
  return hits.flatMap((hit) => queryUnits(db, "WHERE units.evidence_id = ?", [hit.evidenceId]));
}

function lexicalHits(
  db: IndexDb,
  query: string,
  hints: readonly string[],
  search: (db: IndexDb, text: string) => SearchHit[],
): UnitRow[] {
  const text = [query, ...hints].filter((item) => item.length > 0).join(" ");
  if (text.trim() === "") {
    return [];
  }
  const hits = search(db, text);
  hits.sort((left, right) => left.rank - right.rank);
  return hitsToRows(db, hits);
}

function failureNode(host: EvidenceChannelHost, id: RetrievalChannelId, extractorId: string, error: unknown): EvidenceNode {
  const digest = asObjectDigest(sha256Utf8(error instanceof Error ? error.message : "channel-failure"));
  return createEvidenceNode({
    snapshotId: host.snapshotId,
    kind: "unknown",
    identityKey: `channel-failure:${id}`,
    authorship: "DETERMINISTIC",
    label: `channel ${id} failed`,
    status: "unknown",
    contentObjectDigest: digest,
    trust: defaultTrust({
      independenceGroup: independenceGroupFor(`channel-failure:${id}`, digest),
      authority: 0,
      directness: "observed",
      extractorReliability: 0,
    }),
    provenance: [
      makeProvenance({
        source: artifactSourceRef({ artifactObjectDigest: digest, quoteDigest: digest }),
        extractorId,
        extractorVersion: "failure/v1",
        observedAt: host.nowIso(),
        contentDigest: digest,
      }),
    ],
    estimatedTokens: 1,
  });
}

function makeChannel(
  host: EvidenceChannelHost,
  id: RetrievalChannelId,
  probe: (db: IndexDb | undefined) => ChannelProbe,
  load: (db: IndexDb, query: string, hints: readonly string[], filters: RetrievalAction["filters"]) => UnitRow[],
): RetrievalChannel {
  const extractorId = `pi-hec-channel-${id}/v1`;
  const run = async function* (
    query: string,
    hints: readonly string[],
    claimIds: readonly EvidenceId[],
    filters: RetrievalAction["filters"],
    signal: AbortSignal,
  ): AsyncIterable<EvidenceDelta> {
    await throwIfAborted(signal);
    const status = probe(host.db);
    if (host.db === undefined || status === "unavailable") {
      yield toDelta(host, { channelId: id, candidates: [] }, [capabilityNode(host, id, "unavailable")], claimIds);
      return;
    }
    try {
      await throwIfAborted(signal);
      const { candidates } = candidatesFromRows(id, load(host.db, query, hints, filters), extractorId, host.nowIso(), host.db);
      yield toDelta(
        host,
        { channelId: id, candidates },
        status === "degraded" ? [capabilityNode(host, id, "degraded")] : [],
        candidates.length === 0 ? claimIds : [],
      );
    } catch (error) {
      yield toDelta(host, { channelId: id, candidates: [] }, [failureNode(host, id, extractorId, error)], claimIds);
    }
  };
  return {
    id,
    versionObjectDigest: channelVersionDigest(id),
    probe: () => Promise.resolve(probe(host.db)),
    async *seed(intent, signal) {
      if (!INTENT.Check(intent)) {
        throw new Error("retrieval intent failed schema validation");
      }
      yield* run(intent.entityHints[0] ?? "", [...intent.entityHints], asEvidenceIds(intent.claimIds), {}, signal);
    },
    async *expand(action, signal) {
      const hints = [action.query, filterValue(action.filters, "path"), filterValue(action.filters, "symbol")].filter(
        (item): item is string => item !== undefined,
      );
      yield* run(action.query, hints, asEvidenceIds(action.targetClaimIds), action.filters, signal);
    },
  };
}

function countProbe(db: IndexDb | undefined, sql: string): ChannelProbe {
  if (db === undefined) {
    return "unavailable";
  }
  try {
    const row = db.prepare(sql).get() as { n: number } | undefined;
    return (row?.n ?? 0) > 0 ? "available" : "degraded";
  } catch {
    return "unavailable";
  }
}

function indexProbe(db: IndexDb | undefined): ChannelProbe {
  return countProbe(db, "SELECT COUNT(*) AS n FROM units");
}

function gitProbe(db: IndexDb | undefined): ChannelProbe {
  return countProbe(db, "SELECT COUNT(*) AS n FROM git_commits");
}

function scipProbe(db: IndexDb | undefined): ChannelProbe {
  const base = indexProbe(db);
  if (base !== "available" || db === undefined) {
    return base;
  }
  return countProbe(db, "SELECT COUNT(*) AS n FROM graph_edges WHERE relation = 'REFERENCES'");
}

function loadWhere(where: string): (db: IndexDb, query: string, hints: readonly string[]) => UnitRow[] {
  return (db, query, hints) => unitsByHints(db, query, hints, where, []);
}

export function createRetrievalChannels(host: EvidenceChannelHost): RetrievalChannel[] {
  const exact = makeChannel(host, "exact", indexProbe, (db, query, hints, filters) => {
    const extra: string[] = [];
    const params: unknown[] = [];
    const pathFilter = filterValue(filters, "path");
    const symbol = filterValue(filters, "symbol");
    if (pathFilter !== undefined) {
      extra.push("units.path = ?");
      params.push(pathFilter);
    }
    if (symbol !== undefined) {
      extra.push("units.symbol_id = ?");
      params.push(symbol);
    }
    return unitsByHints(db, query, hints, extra.join(" AND "), params);
  });
  const bm25 = makeChannel(host, "bm25", indexProbe, (db, query, hints) =>
    lexicalHits(db, query, hints, (index, text) => searchBm25(index, text, { limit: 50 })),
  );
  const dense = makeChannel(host, "dense", indexProbe, (db, query, hints) =>
    lexicalHits(db, query, hints, (index, text) => searchVector(index, text, { k: 50 })),
  );
  const ast = makeChannel(host, "ast", indexProbe, loadWhere("units.kind IN ('function','method','class','top-level')"));
  const scip = makeChannel(
    host,
    "scip",
    scipProbe,
    loadWhere(
      "units.symbol_id != '' AND (EXISTS (SELECT 1 FROM graph_edges e WHERE e.relation = 'REFERENCES' AND (e.from_id = units.evidence_id OR e.to_id = units.evidence_id)) OR INSTR(units.symbol_id, 'scip') > 0)",
    ),
  );
  const dataflow = makeChannel(host, "dataflow", indexProbe, (db, query, hints) => {
    const seeds = unitsByHints(db, query, hints, "", []);
    const neighborIds = new Set(seeds.map((row) => row.evidenceId));
    for (const edge of queryEdges(db, [...neighborIds]).filter(
      (item) => item.relation === "IMPORTS" || item.relation === "REFERENCES" || item.relation === "DEFINES",
    )) {
      neighborIds.add(edge.fromId);
      neighborIds.add(edge.toId);
    }
    return [...neighborIds].flatMap((id) => queryUnits(db, "WHERE units.evidence_id = ?", [id]));
  });
  const tests = makeChannel(host, "tests", indexProbe, loadWhere("units.kind = 'test' OR files.category = 'test'"));
  const gitHistory = makeChannel(host, "git-history", gitProbe, (db, query, hints) =>
    unitsByHints(db, query, hints, "units.kind IN ('commit','diff')", []),
  );
  const analogues = makeChannel(host, "analogues", indexProbe, (db, query, hints) => {
    const seeds = unitsByHints(db, query, hints, "", []);
    const rows = [...seeds];
    for (const symbolId of new Set(seeds.map((row) => row.symbolId).filter((item) => item.length > 0))) {
      rows.push(...queryUnits(db, "WHERE units.symbol_id = ?", [symbolId]));
    }
    for (const seedPath of seeds.map((row) => row.path)) {
      const partners = db
        .prepare(
          "SELECT path_b AS path FROM git_cochange WHERE path_a = ? UNION SELECT path_a AS path FROM git_cochange WHERE path_b = ?",
        )
        .all(seedPath, seedPath) as { path: string }[];
      for (const partner of partners) {
        rows.push(...queryUnits(db, "WHERE units.path = ?", [partner.path]));
      }
    }
    return rows;
  });
  const buildConfig = makeChannel(
    host,
    "build-config",
    indexProbe,
    loadWhere("units.kind IN ('config-block','schema-object') OR files.category = 'config'"),
  );
  const instructions = makeChannel(host, "instructions", indexProbe, loadWhere("files.category = 'instruction'"));
  return [exact, bm25, dense, hybridChannel(host, bm25, dense), ast, scip, dataflow, tests, gitHistory, analogues, buildConfig, instructions, externalDocsChannel(host), localHypothesisChannel(host)];
}

function hybridChannel(host: EvidenceChannelHost, bm25: RetrievalChannel, dense: RetrievalChannel): RetrievalChannel {
  const id: RetrievalChannelId = "hybrid";
  return {
    id,
    versionObjectDigest: channelVersionDigest(id),
    async probe(snapshotId) {
      const left = await bm25.probe(snapshotId);
      const right = await dense.probe(snapshotId);
      if (left === "unavailable" && right === "unavailable") {
        return "unavailable";
      }
      return left === "available" && right === "available" ? "available" : "degraded";
    },
    async *seed(intent, signal) {
      const fused = fuseRankings(await rankingsFromChannels([bm25, dense], intent, signal), host.nowIso());
      yield toDelta(
        host,
        {
          channelId: id,
          candidates: fused.ranked.map((item, index) => ({
            evidenceId: item.evidenceId,
            identityKey: item.identityKey,
            channelId: id,
            rank: index + 1,
            node: item.node,
            edges: item.edges,
          })),
        },
        [],
        fused.ranked.length === 0 ? asEvidenceIds(intent.claimIds) : [],
      );
    },
    async *expand(action, signal) {
      if (host.runId === undefined) {
        throw new Error("hybrid expand requires runId from RetrievalIntent on the evidence channel host");
      }
      const hints = [action.query, filterValue(action.filters, "path"), filterValue(action.filters, "symbol")].filter(
        (item): item is string => item !== undefined && item.length > 0,
      );
      yield* this.seed(
        {
          runId: host.runId,
          snapshotId: host.snapshotId,
          claimIds: asEvidenceIds(action.targetClaimIds),
          entityHints: hints.length > 0 ? hints : [action.query],
          relationHints: [],
        },
        signal,
      );
    },
  };
}

function externalDocsChannel(host: EvidenceChannelHost): RetrievalChannel {
  const id: RetrievalChannelId = "external-docs";
  return {
    id,
    versionObjectDigest: channelVersionDigest(id),
    probe: () => Promise.resolve(host.fetchExternal === undefined ? "unavailable" : "available"),
    async *seed(intent, signal) {
      await throwIfAborted(signal);
      if (host.fetchExternal === undefined) {
        yield toDelta(host, { channelId: id, candidates: [] }, [capabilityNode(host, id, "unavailable")], asEvidenceIds(intent.claimIds));
      }
    },
    async *expand(action, signal) {
      await throwIfAborted(signal);
      const url = filterValue(action.filters, "url");
      if (host.fetchExternal === undefined || url === undefined || host.putBlob === undefined) {
        yield toDelta(host, { channelId: id, candidates: [] }, [capabilityNode(host, id, "unavailable")], asEvidenceIds(action.targetClaimIds));
        return;
      }
      const result = await host.fetchExternal({ requestedUrl: url, putBlob: host.putBlob, nowIso: host.nowIso });
      const digest = asObjectDigest(result.receipt.sanitizedContentObjectDigest);
      const node = createEvidenceNode({
        snapshotId: host.snapshotId,
        kind: result.versionConflict ? "conflict" : "external-documentation",
        identityKey: `external:${url}`.slice(0, 1024),
        authorship: "DETERMINISTIC",
        label: url,
        contentObjectDigest: digest,
        status: result.versionConflict ? "conflicted" : "probable",
        trust: defaultTrust({
          independenceGroup: independenceGroupFor("pi-hec-external-docs/v1", digest),
          authority: 0.25,
          directness: "observed",
          extractorReliability: 0.6,
          freshness: 1,
          adversarialRisk: 0.8,
        }),
        provenance: [
          makeProvenance({
            source: {
              origin: "external",
              sourceKind: "external-documentation",
              fetchReceiptObjectDigest: digest,
              artifactObjectDigest: digest,
              url,
              range: { kind: "whole" },
              quoteDigest: digest,
            },
            extractorId: "pi-hec-channel-external-docs/v1",
            extractorVersion: "untrusted-data/v1",
            observedAt: host.nowIso(),
            contentDigest: digest,
          }),
        ],
        estimatedTokens: estimatedTokensFor(url),
      });
      yield toDelta(host, { channelId: id, candidates: [] }, [node], []);
    },
  };
}

function localHypothesisChannel(host: EvidenceChannelHost): RetrievalChannel {
  const id: RetrievalChannelId = "local-hypothesis";
  return {
    id,
    versionObjectDigest: channelVersionDigest(id),
    probe: () => Promise.resolve("available"),
    async *seed(intent, signal) {
      await throwIfAborted(signal);
      const nodes = (host.localProposals ?? []).map((proposal) =>
        ingestLocalEvidenceProposal(host.snapshotId, proposal, host.nowIso()),
      );
      yield toDelta(host, { channelId: id, candidates: [] }, nodes, nodes.length === 0 ? [] : asEvidenceIds(intent.claimIds));
    },
    async *expand(action, signal) {
      await throwIfAborted(signal);
      const proposalId = filterValue(action.filters, "proposalId");
      const nodes = (host.localProposals ?? [])
        .filter((item) => proposalId === undefined || item.proposalId === proposalId)
        .map((proposal) => ingestLocalEvidenceProposal(host.snapshotId, proposal, host.nowIso()));
      yield toDelta(host, { channelId: id, candidates: [] }, nodes, asEvidenceIds(action.targetClaimIds));
    },
  };
}

export function ingestLocalEvidenceProposal(
  snapshotId: SnapshotId,
  proposal: LocalEvidenceProposal,
  observedAt: string,
): EvidenceNode {
  if (!PROPOSAL.Check(proposal)) {
    throw new Error("local evidence proposal failed schema validation");
  }
  const digest = asObjectDigest(sha256Utf8(proposal.statement));
  const sources: SourceRef[] =
    proposal.citedSourceRefs.length > 0
      ? [...proposal.citedSourceRefs]
      : [artifactSourceRef({ artifactObjectDigest: digest, quoteDigest: digest, sourceKind: "model-output" })];
  return createEvidenceNode({
    snapshotId,
    kind: proposal.kind,
    identityKey: `local-proposal:${proposal.proposalId}`.slice(0, 1024),
    authorship: "LOCAL_MODEL",
    label: proposal.statement.slice(0, 1024),
    contentObjectDigest: digest,
    status: proposal.kind === "conflict" ? "conflicted" : "unknown",
    trust: defaultTrust({
      independenceGroup: independenceGroupFor("local-model", digest),
      authority: 0.2,
      directness: "model-derived",
      extractorReliability: 0.3,
      freshness: 1,
      adversarialRisk: 0.4,
    }),
    provenance: sources.map((source) =>
      makeProvenance({
        source,
        extractorId: "pi-hec-local-evidence-proposal/v1",
        extractorVersion: "advisory/v1",
        observedAt,
        contentDigest: digest,
      }),
    ),
    estimatedTokens: estimatedTokensFor(proposal.statement),
  });
}

export function rankingFromDeltas(channel: RetrievalChannel, deltas: readonly EvidenceDelta[]): ChannelRanking {
  const candidates: RankedCandidate[] = [];
  for (const delta of deltas) {
    for (const node of delta.nodes) {
      if (isCapabilityNode(node)) {
        continue;
      }
      candidates.push({
        evidenceId: asEvidenceId(node.id),
        identityKey: node.identityKey,
        channelId: channel.id,
        rank: candidates.length + 1,
        node,
        edges: delta.edges,
      });
    }
  }
  return { channelId: channel.id, candidates };
}

export async function rankingsFromChannels(
  channels: readonly RetrievalChannel[],
  intent: RetrievalIntent,
  signal: AbortSignal,
): Promise<ChannelRanking[]> {
  const rankings: ChannelRanking[] = [];
  for (const channel of channels) {
    await throwIfAborted(signal);
    rankings.push(rankingFromDeltas(channel, await collectDeltas(channel.seed(intent, signal))));
  }
  return rankings;
}

export async function collectDeltas(iterable: AsyncIterable<EvidenceDelta>): Promise<EvidenceDelta[]> {
  const deltas: EvidenceDelta[] = [];
  for await (const delta of iterable) {
    deltas.push(delta);
  }
  return deltas;
}

export { openIndexDatabase };
export type { SearchHit, ExternalFetchInput, ExternalFetchResult };
