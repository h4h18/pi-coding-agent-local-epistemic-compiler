import {
  canonicalizeRfc8785,
  type EvidenceEdge,
  type EvidenceId,
  type EvidenceNode,
} from "@pi-hec/contracts";
import { objectDigestFromBytes } from "@pi-hec/domain";
import {
  FUSION_EXTRACTOR_ID,
  FUSION_EXTRACTOR_VERSION,
  artifactSourceRef,
  compareUtf8,
  makeProvenance,
  type EvidenceNodeDraft,
} from "./graph.js";

export const RRF_K = 60;

export const RETRIEVAL_CHANNEL_IDS = [
  "exact",
  "bm25",
  "dense",
  "hybrid",
  "ast",
  "scip",
  "dataflow",
  "tests",
  "git-history",
  "analogues",
  "build-config",
  "instructions",
  "external-docs",
  "local-hypothesis",
] as const;

export type RetrievalChannelId = (typeof RETRIEVAL_CHANNEL_IDS)[number];

export const FUSION_WEIGHTS_VERSION = 1;

export const FUSION_CHANNEL_WEIGHTS: { readonly [K in RetrievalChannelId]: number } = {
  exact: 1.4,
  bm25: 1,
  dense: 1,
  hybrid: 1.1,
  ast: 1.2,
  scip: 1.3,
  dataflow: 1.2,
  tests: 1.3,
  "git-history": 1.1,
  analogues: 0.8,
  "build-config": 1,
  instructions: 1.4,
  "external-docs": 0.6,
  "local-hypothesis": 0.4,
};

export const FUSION_WEIGHTS_DIGEST = objectDigestFromBytes(
  Buffer.from(
    canonicalizeRfc8785({
      version: FUSION_WEIGHTS_VERSION,
      k: RRF_K,
      weights: FUSION_CHANNEL_WEIGHTS,
    }),
    "utf8",
  ),
);

export type RankedCandidate = {
  evidenceId: EvidenceId;
  identityKey: string;
  channelId: RetrievalChannelId;
  rank: number;
  node: EvidenceNode;
  edges: readonly EvidenceEdge[];
};

export type ChannelRanking = {
  channelId: RetrievalChannelId;
  candidates: readonly RankedCandidate[];
};

export type RerankerFeatures = {
  lexicalRank: number | undefined;
  denseRank: number | undefined;
  graphDistance: number | undefined;
  edgeReliability: number | undefined;
  requirementRole: number | undefined;
  runtimeTestSupport: number | undefined;
  sourceAuthority: number;
  freshness: number;
  pathInstructionApplicability: number | undefined;
  sourceIndependence: string;
  tokenCost: number;
  adversarialRisk: number;
  contributingChannelIds: readonly RetrievalChannelId[];
  rrfScore: number;
};

export type FusedCandidate = {
  evidenceId: EvidenceId;
  identityKey: string;
  rrfScore: number;
  node: EvidenceNode;
  edges: readonly EvidenceEdge[];
  features: RerankerFeatures;
  tieBreak: {
    identityKey: string;
    channelId: RetrievalChannelId;
    evidenceId: EvidenceId;
  };
};

export type FusionResult = {
  weightsDigest: typeof FUSION_WEIGHTS_DIGEST;
  weightsVersion: typeof FUSION_WEIGHTS_VERSION;
  k: typeof RRF_K;
  ranked: readonly FusedCandidate[];
};

export function rrfContribution(channelId: RetrievalChannelId, rank: number): number {
  if (!Number.isInteger(rank) || rank < 1) {
    throw new Error(`RRF rank must be a 1-based integer, got ${String(rank)}`);
  }
  return FUSION_CHANNEL_WEIGHTS[channelId] / (RRF_K + rank);
}

function positionalCandidates(ranking: ChannelRanking): RankedCandidate[] {
  return ranking.candidates.map((candidate, index) => ({
    ...candidate,
    channelId: ranking.channelId,
    rank: index + 1,
  }));
}

export function fuseRankings(
  rankings: readonly ChannelRanking[],
  observedAt: string,
): FusionResult {
  const byId = new Map<
    string,
    {
      identityKey: string;
      evidenceId: EvidenceId;
      node: EvidenceNode;
      edges: EvidenceEdge[];
      score: number;
      channels: RetrievalChannelId[];
      lexicalRank: number | undefined;
      denseRank: number | undefined;
    }
  >();
  for (const ranking of rankings) {
    for (const candidate of positionalCandidates(ranking)) {
      const existing = byId.get(candidate.evidenceId);
      const contribution = rrfContribution(ranking.channelId, candidate.rank);
      if (existing === undefined) {
        byId.set(candidate.evidenceId, {
          identityKey: candidate.identityKey,
          evidenceId: candidate.evidenceId,
          node: candidate.node,
          edges: [...candidate.edges],
          score: contribution,
          channels: [ranking.channelId],
          lexicalRank: ranking.channelId === "bm25" ? candidate.rank : undefined,
          denseRank: ranking.channelId === "dense" ? candidate.rank : undefined,
        });
        continue;
      }
      existing.score += contribution;
      existing.channels.push(ranking.channelId);
      existing.edges.push(...candidate.edges);
      existing.node = {
        ...existing.node,
        provenance: [...existing.node.provenance, ...candidate.node.provenance],
        estimatedTokens: Math.max(existing.node.estimatedTokens, candidate.node.estimatedTokens),
      };
      if (ranking.channelId === "bm25") {
        existing.lexicalRank = candidate.rank;
      }
      if (ranking.channelId === "dense") {
        existing.denseRank = candidate.rank;
      }
    }
  }
  const ranked: FusedCandidate[] = [...byId.values()].map((entry) => {
    const channelId = [...entry.channels].sort(compareUtf8)[0];
    if (channelId === undefined) {
      throw new Error("fused candidate missing channel id");
    }
    const fusionProvenance = makeProvenance({
      source: artifactSourceRef({
        artifactObjectDigest: FUSION_WEIGHTS_DIGEST,
        quoteDigest: FUSION_WEIGHTS_DIGEST,
        sourceKind: "runtime",
      }),
      extractorId: FUSION_EXTRACTOR_ID,
      extractorVersion: FUSION_EXTRACTOR_VERSION,
      observedAt,
      contentDigest: FUSION_WEIGHTS_DIGEST,
    });
    const node: EvidenceNode = {
      ...entry.node,
      provenance: [...entry.node.provenance, fusionProvenance],
    };
    const features: RerankerFeatures = {
      lexicalRank: entry.lexicalRank,
      denseRank: entry.denseRank,
      graphDistance: undefined,
      edgeReliability: undefined,
      requirementRole: undefined,
      runtimeTestSupport: undefined,
      sourceAuthority: node.trust.authority,
      freshness: node.trust.freshness,
      pathInstructionApplicability: undefined,
      sourceIndependence: node.trust.independenceGroup,
      tokenCost: node.estimatedTokens,
      adversarialRisk: node.trust.adversarialRisk,
      contributingChannelIds: [...entry.channels].sort(compareUtf8),
      rrfScore: entry.score,
    };
    return {
      evidenceId: entry.evidenceId,
      identityKey: entry.identityKey,
      rrfScore: entry.score,
      node,
      edges: entry.edges,
      features,
      tieBreak: {
        identityKey: entry.identityKey,
        channelId,
        evidenceId: entry.evidenceId,
      },
    };
  });
  ranked.sort((left, right) => {
    if (right.rrfScore !== left.rrfScore) {
      return right.rrfScore - left.rrfScore;
    }
    const key = compareUtf8(left.tieBreak.identityKey, right.tieBreak.identityKey);
    if (key !== 0) {
      return key;
    }
    const channel = compareUtf8(left.tieBreak.channelId, right.tieBreak.channelId);
    if (channel !== 0) {
      return channel;
    }
    return compareUtf8(left.tieBreak.evidenceId, right.tieBreak.evidenceId);
  });
  return {
    weightsDigest: FUSION_WEIGHTS_DIGEST,
    weightsVersion: FUSION_WEIGHTS_VERSION,
    k: RRF_K,
    ranked,
  };
}

export function attachFusionProvenance(
  draft: EvidenceNodeDraft,
  observedAt: string,
): EvidenceNodeDraft {
  return {
    ...draft,
    provenance: [
      ...draft.provenance,
      makeProvenance({
        source: artifactSourceRef({
          artifactObjectDigest: FUSION_WEIGHTS_DIGEST,
          quoteDigest: FUSION_WEIGHTS_DIGEST,
          sourceKind: "runtime",
        }),
        extractorId: FUSION_EXTRACTOR_ID,
        extractorVersion: FUSION_EXTRACTOR_VERSION,
        observedAt,
        contentDigest: FUSION_WEIGHTS_DIGEST,
      }),
    ],
  };
}
