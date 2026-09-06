import { expect, test } from "vitest";
import { fuseRankings, rrfContribution, FUSION_WEIGHTS_DIGEST, RRF_K } from "../src/fusion.js";
import { isVolatileExtractor } from "../src/graph.js";
import { sampleNode } from "./helpers.js";
import type { RankedCandidate } from "../src/fusion.js";

test("RRF uses weight/(60+rank) and never adds raw BM25 or cosine", () => {
  const nodeA = sampleNode({ identityKey: "a", producer: "idx/v1", blob: "A" });
  const nodeB = sampleNode({ identityKey: "b", producer: "idx/v1", blob: "B" });
  const denseList: RankedCandidate[] = [
    { evidenceId: nodeB.id, identityKey: "b", channelId: "dense", rank: 1, node: nodeB, edges: [] },
  ];
  for (let index = 2; index <= 9; index += 1) {
    const filler = sampleNode({
      identityKey: `pad-${String(index)}`,
      producer: "idx/v1",
      blob: `P${String(index)}`,
    });
    denseList.push({
      evidenceId: filler.id,
      identityKey: filler.identityKey,
      channelId: "dense",
      rank: index,
      node: filler,
      edges: [],
    });
  }
  denseList.push({
    evidenceId: nodeA.id,
    identityKey: "a",
    channelId: "dense",
    rank: 10,
    node: nodeA,
    edges: [],
  });
  const fused = fuseRankings(
    [
      {
        channelId: "bm25",
        candidates: [
          {
            evidenceId: nodeA.id,
            identityKey: "a",
            channelId: "bm25",
            rank: 1,
            node: nodeA,
            edges: [],
          },
          {
            evidenceId: nodeB.id,
            identityKey: "b",
            channelId: "bm25",
            rank: 2,
            node: nodeB,
            edges: [],
          },
        ],
      },
      { channelId: "dense", candidates: denseList },
    ],
    "2026-08-28T00:00:00.000Z",
  );
  const scoreA = rrfContribution("bm25", 1) + rrfContribution("dense", 10);
  const scoreB = rrfContribution("bm25", 2) + rrfContribution("dense", 1);
  expect(scoreB).toBeGreaterThan(scoreA);
  expect(fused.ranked[0]?.identityKey).toBe("b");
  expect(fused.ranked[0]?.rrfScore).toBeCloseTo(scoreB, 12);
  expect(fused.k).toBe(RRF_K);
  expect(fused.weightsDigest).toBe(FUSION_WEIGHTS_DIGEST);
  expect(
    fused.ranked[0]?.node.provenance.some((item) => isVolatileExtractor(item.extractorId)),
  ).toBe(true);
  expect(
    fused.ranked[0]?.node.provenance.some((item) => item.contentDigest === FUSION_WEIGHTS_DIGEST),
  ).toBe(true);
});

test("positional rank ignores stuffed BM25 and cosine score fields", () => {
  const nodeA = sampleNode({ identityKey: "a", producer: "idx/v1", blob: "A" });
  const nodeB = sampleNode({ identityKey: "b", producer: "idx/v1", blob: "B" });
  const bm25HighScores: RankedCandidate[] = [
    {
      evidenceId: nodeA.id,
      identityKey: "a",
      channelId: "bm25",
      rank: 9999,
      node: nodeA,
      edges: [],
    },
    {
      evidenceId: nodeB.id,
      identityKey: "b",
      channelId: "bm25",
      rank: -50,
      node: nodeB,
      edges: [],
    },
  ];
  const fused = fuseRankings(
    [{ channelId: "bm25", candidates: bm25HighScores }],
    "2026-08-28T00:00:00.000Z",
  );
  expect(fused.ranked[0]?.identityKey).toBe("a");
  expect(fused.ranked[0]?.rrfScore).toBeCloseTo(rrfContribution("bm25", 1), 12);
  expect(fused.ranked[1]?.rrfScore).toBeCloseTo(rrfContribution("bm25", 2), 12);
});

test("tie-breaks are identityKey, then channel id, then evidence id", () => {
  const left = sampleNode({ identityKey: "aaa", producer: "idx/v1", blob: "L" });
  const right = sampleNode({ identityKey: "bbb", producer: "idx/v1", blob: "R" });
  const fused = fuseRankings(
    [
      {
        channelId: "bm25",
        candidates: [
          {
            evidenceId: left.id,
            identityKey: "aaa",
            channelId: "bm25",
            rank: 1,
            node: left,
            edges: [],
          },
        ],
      },
      {
        channelId: "dense",
        candidates: [
          {
            evidenceId: right.id,
            identityKey: "bbb",
            channelId: "dense",
            rank: 1,
            node: right,
            edges: [],
          },
        ],
      },
    ],
    "2026-08-28T00:00:00.000Z",
  );
  expect(fused.ranked[0]?.rrfScore).toBe(fused.ranked[1]?.rrfScore);
  expect(fused.ranked.map((item) => item.identityKey)).toEqual(["aaa", "bbb"]);
});

test("reranker features record ranks without collapsing trust to a scalar", () => {
  const node = sampleNode({ identityKey: "feat", producer: "idx/v1", blob: "F" });
  const fused = fuseRankings(
    [
      {
        channelId: "bm25",
        candidates: [
          { evidenceId: node.id, identityKey: "feat", channelId: "bm25", rank: 3, node, edges: [] },
        ],
      },
      {
        channelId: "dense",
        candidates: [
          {
            evidenceId: node.id,
            identityKey: "feat",
            channelId: "dense",
            rank: 4,
            node,
            edges: [],
          },
        ],
      },
    ],
    "2026-08-28T00:00:00.000Z",
  );
  const top = fused.ranked[0];
  expect(top?.features.lexicalRank).toBe(1);
  expect(top?.features.denseRank).toBe(1);
  expect(top?.features.sourceIndependence).toBe(node.trust.independenceGroup);
  expect(top?.features.sourceAuthority).toBe(node.trust.authority);
  expect(top?.node.trust.independenceGroup).toBe(node.trust.independenceGroup);
  expect(top?.features.contributingChannelIds).toEqual(["bm25", "dense"]);
});
