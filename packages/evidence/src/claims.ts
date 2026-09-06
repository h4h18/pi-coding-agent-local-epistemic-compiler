import { Compile } from "typebox/compile";
import {
  EvidenceDeltaSchema,
  RetrievalIntentSchema,
  type EvidenceId,
  type EvidenceNode,
} from "@pi-hec/contracts";
import {
  collectDeltas,
  createRetrievalChannels,
  hostGraph,
  isCapabilityNode,
  queryUnitsByEvidenceIds,
  queryUnitsByPathBytes,
  rankingFromDeltas,
  throwIfAborted,
  unitToSubject,
  type EvidenceChannelHost,
  type RetrievalIntent,
} from "./channels.js";
import { dedupeEvidence, subjectFromNode, type DedupeSubject } from "./dedupe.js";
import {
  RETRIEVAL_CHANNEL_IDS,
  fuseRankings,
  type ChannelRanking,
  type FusionResult,
  type FusedCandidate,
  type RetrievalChannelId,
} from "./fusion.js";
import {
  asEvidenceId,
  asSnapshotId,
  compareUtf8,
  evidenceGraphDigest,
  mergeEvidence,
  type EvidenceDelta,
} from "./graph.js";

const INTENT = Compile(RetrievalIntentSchema);
const DELTA = Compile(EvidenceDeltaSchema);

export type RetrieveAndFuseResult = {
  graph: ReturnType<typeof hostGraph>;
  delta: EvidenceDelta;
  fusion: FusionResult;
  subjects: readonly DedupeSubject[];
};

const PRIMITIVE_CHANNELS: ReadonlySet<RetrievalChannelId> = new Set(
  RETRIEVAL_CHANNEL_IDS.filter((id) => id !== "hybrid"),
);

function subjectsForRanked(
  host: EvidenceChannelHost,
  ranked: readonly FusedCandidate[],
): DedupeSubject[] {
  const rows =
    host.db === undefined
      ? []
      : queryUnitsByEvidenceIds(
          host.db,
          ranked.map((item) => item.evidenceId),
        );
  const byId = new Map<string, (typeof rows)[number]>(rows.map((row) => [row.evidenceId, row]));
  return ranked.map((item) => {
    const row = byId.get(item.evidenceId) ?? byId.get(item.node.id);
    if (row !== undefined) {
      return unitToSubject(row, item.node);
    }
    const fallback = subjectFromNode(item.node);
    if (host.db !== undefined && fallback.path !== item.node.identityKey) {
      const matched = queryUnitsByPathBytes(
        host.db,
        fallback.path,
        fallback.byteStart,
        fallback.byteEnd,
      );
      const hit = matched[0];
      if (hit !== undefined) {
        return unitToSubject(hit, item.node);
      }
    }
    return fallback;
  });
}

export async function retrieveAndFuse(
  host: EvidenceChannelHost,
  intent: RetrievalIntent,
  signal: AbortSignal,
): Promise<RetrieveAndFuseResult> {
  if (!INTENT.Check(intent)) {
    throw new Error("retrieval intent failed schema validation");
  }
  const boundHost: EvidenceChannelHost = { ...host, runId: host.runId ?? intent.runId };
  const extraNodes: EvidenceNode[] = [];
  const unresolved = new Set<EvidenceId>();
  const rankings: ChannelRanking[] = [];
  for (const channel of createRetrievalChannels(boundHost).filter((item) =>
    PRIMITIVE_CHANNELS.has(item.id),
  )) {
    await throwIfAborted(signal);
    const probe = await channel.probe(asSnapshotId(intent.snapshotId));
    if (
      probe === "unavailable" &&
      channel.id !== "external-docs" &&
      channel.id !== "local-hypothesis"
    ) {
      for (const claimId of intent.claimIds) {
        unresolved.add(asEvidenceId(claimId));
      }
    }
    const deltas = await collectDeltas(channel.seed(intent, signal));
    for (const delta of deltas) {
      for (const claimId of delta.unresolvedClaimIds) {
        unresolved.add(asEvidenceId(claimId));
      }
      extraNodes.push(...delta.nodes.filter(isCapabilityNode));
    }
    rankings.push(rankingFromDeltas(channel, deltas));
  }
  const fusion = fuseRankings(rankings, boundHost.nowIso());
  const subjects = subjectsForRanked(boundHost, fusion.ranked);
  const deduped = dedupeEvidence(
    subjects,
    fusion.ranked.flatMap((item) => [...item.edges]),
  );
  const base = hostGraph(boundHost);
  const uniqueNodes = [
    ...new Map([...deduped.nodes, ...extraNodes].map((node) => [node.id, node])).values(),
  ].sort((left, right) => compareUtf8(left.id, right.id));
  const known = new Set([
    ...base.nodes.map((node) => node.id),
    ...uniqueNodes.map((node) => node.id),
  ]);
  const edges = deduped.edges.filter((edge) => known.has(edge.from) && known.has(edge.to));
  const graph = mergeEvidence(base, uniqueNodes, edges);
  const delta: EvidenceDelta = {
    schemaVersion: 1,
    baseEvidenceGraphObjectDigest: evidenceGraphDigest(base),
    nodes: uniqueNodes,
    edges,
    unresolvedClaimIds: [...unresolved].sort(compareUtf8),
    nextActions: [],
  };
  if (!DELTA.Check(delta)) {
    throw new Error("fused evidence delta failed schema validation");
  }
  return { graph, delta, fusion, subjects: deduped.subjects };
}

export {
  collectDeltas,
  createRetrievalChannels,
  ingestLocalEvidenceProposal,
  openIndexDatabase,
  unitToSubject,
} from "./channels.js";
export type {
  ChannelProbe,
  EvidenceChannelHost,
  LocalEvidenceProposal,
  RetrievalChannel,
  RetrievalIntent,
} from "./channels.js";
