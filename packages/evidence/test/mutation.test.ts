import { assert, integer, property } from "fast-check";
import { expect, test } from "vitest";
import { fuseRankings, rrfContribution } from "../src/fusion.js";
import { dedupeEvidence } from "../src/dedupe.js";
import { mergeEvidence, mergeProvenance, emptyEvidenceGraph } from "../src/graph.js";
import { SNAPSHOT_ID, sampleNode, sampleSubject } from "./helpers.js";
import type { RankedCandidate } from "../src/fusion.js";

test("mutation: graph merge never drops provenance entries", () => {
  assert(
    property(integer({ min: 1, max: 5 }), integer({ min: 1, max: 5 }), (leftCount, rightCount) => {
      const left = Array.from({ length: leftCount }, (_, index) =>
        sampleNode({
          identityKey: `n${String(index)}`,
          producer: `l${String(index)}/v1`,
          blob: `b${String(index)}`,
        }),
      );
      const right = Array.from({ length: rightCount }, (_, index) =>
        sampleNode({
          identityKey: `n${String(index)}`,
          producer: `r${String(index)}/v1`,
          blob: `b${String(index)}`,
        }),
      );
      const graph = mergeEvidence(emptyEvidenceGraph(SNAPSHOT_ID), [...left, ...right], []);
      for (const node of [...left, ...right]) {
        const found = graph.nodes.find((item) => item.id === node.id);
        expect(found).toBeDefined();
        const identities = new Set((found?.provenance ?? []).map((item) => item.extractorId));
        expect(identities.has(node.provenance[0]?.extractorId ?? "")).toBe(true);
      }
      const union = mergeProvenance(left[0]?.provenance ?? [], right[0]?.provenance ?? []);
      expect(union.length).toBeGreaterThan(0);
    }),
  );
});

test("mutation: fusion never adds BM25 and cosine scores", () => {
  const nodeA = sampleNode({ identityKey: "ma", producer: "idx/v1", blob: "A" });
  const nodeB = sampleNode({ identityKey: "mb", producer: "idx/v1", blob: "B" });
  const bm25: RankedCandidate[] = [
    { evidenceId: nodeA.id, identityKey: "ma", channelId: "bm25", rank: 1, node: nodeA, edges: [] },
    { evidenceId: nodeB.id, identityKey: "mb", channelId: "bm25", rank: 2, node: nodeB, edges: [] },
  ];
  const dense: RankedCandidate[] = [
    {
      evidenceId: nodeB.id,
      identityKey: "mb",
      channelId: "dense",
      rank: 1,
      node: nodeB,
      edges: [],
    },
  ];
  for (let index = 2; index <= 7; index += 1) {
    const filler = sampleNode({
      identityKey: `pad-${String(index)}`,
      producer: "idx/v1",
      blob: `P${String(index)}`,
    });
    dense.push({
      evidenceId: filler.id,
      identityKey: filler.identityKey,
      channelId: "dense",
      rank: index,
      node: filler,
      edges: [],
    });
  }
  dense.push({
    evidenceId: nodeA.id,
    identityKey: "ma",
    channelId: "dense",
    rank: 8,
    node: nodeA,
    edges: [],
  });
  const fused = fuseRankings(
    [
      { channelId: "bm25", candidates: bm25 },
      { channelId: "dense", candidates: dense },
    ],
    "2026-08-28T00:00:00.000Z",
  );
  const rawScoreSumWouldPreferA = 100 + 0.01 > 1 + 0.99;
  expect(rawScoreSumWouldPreferA).toBe(true);
  expect(fused.ranked[0]?.identityKey).toBe("mb");
  expect(fused.ranked.find((item) => item.identityKey === "ma")?.rrfScore).toBe(
    rrfContribution("bm25", 1) + rrfContribution("dense", 8),
  );
});

test("mutation: historical and current evidence stay distinct after dedupe", () => {
  const current = sampleNode({ identityKey: "cur", producer: "chunker/v1", blob: "shared" });
  const historical = sampleNode({
    identityKey: "hist",
    producer: "chunker/v1",
    blob: "shared",
    historical: true,
  });
  const result = dedupeEvidence(
    [
      sampleSubject(current, {
        producer: "chunker/v1",
        path: "src/cur.ts",
        blobDigest: current.contentObjectDigest ?? "",
      }),
      sampleSubject(historical, {
        producer: "chunker/v1",
        path: ".git/commits/hist",
        blobDigest: historical.contentObjectDigest ?? "",
      }),
    ],
    [],
  );
  expect(result.nodes).toHaveLength(2);
});
