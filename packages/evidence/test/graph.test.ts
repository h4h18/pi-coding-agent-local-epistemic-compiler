import { Compile } from "typebox/compile";
import { assert, property, string } from "fast-check";
import { expect, test } from "vitest";
import { EvidenceGraphSchema } from "@pi-hec/contracts";
import {
  applyEvidenceDelta,
  assertEvidenceGraph,
  createEvidenceEdge,
  emptyEvidenceGraph,
  evidenceGraphDigest,
  isHistoricalNode,
  mergeEvidence,
  mergeEvidenceNodes,
  mergeProvenance,
  nodeIdentityId,
} from "../src/graph.js";
import { SNAPSHOT_ID, TS, sampleNode } from "./helpers.js";

const GRAPH = Compile(EvidenceGraphSchema);

test("minted nodes have identity hashes that round-trip", () => {
  const node = sampleNode({
    identityKey: "file:src/a.ts:0:12:a",
    producer: "chunker/v1",
    blob: "alpha",
  });
  expect(nodeIdentityId(SNAPSHOT_ID, node)).toBe(node.id);
  const graph = mergeEvidence(emptyEvidenceGraph(SNAPSHOT_ID), [node], []);
  expect(GRAPH.Check(graph)).toBe(true);
  assertEvidenceGraph(graph);
});

test("provenance-preserving merge unions extractors and keeps identity", () => {
  const left = sampleNode({ identityKey: "same-key", producer: "bm25/v1", blob: "body" });
  const rightBase = sampleNode({ identityKey: "same-key", producer: "dense/v1", blob: "body" });
  const right = {
    ...rightBase,
    id: left.id,
    trust: { ...rightBase.trust, independenceGroup: left.trust.independenceGroup },
  };
  const merged = mergeEvidenceNodes(left, right);
  expect(merged.id).toBe(left.id);
  expect(merged.provenance).toHaveLength(2);
  expect(merged.provenance.map((item) => item.extractorId).sort()).toEqual(["bm25/v1", "dense/v1"]);
  expect(merged.trust.independenceGroup).toBe(left.trust.independenceGroup);
  expect(typeof merged.trust.authority).toBe("number");
  expect(merged.trust.independenceGroup).not.toBe(String(merged.trust.authority));
});

test("two nodes with the same authority and different independenceGroup do not collapse", () => {
  const left = sampleNode({
    identityKey: "copy-a",
    producer: "producer-a/v1",
    blob: "shared-bytes",
    authority: 0.9,
  });
  const right = sampleNode({
    identityKey: "copy-b",
    producer: "producer-b/v1",
    blob: "shared-bytes",
    authority: 0.9,
  });
  expect(left.trust.authority).toBe(right.trust.authority);
  expect(left.trust.independenceGroup).not.toBe(right.trust.independenceGroup);
  expect(left.id).not.toBe(right.id);
  const graph = mergeEvidence(emptyEvidenceGraph(SNAPSHOT_ID), [left, right], []);
  expect(graph.nodes).toHaveLength(2);
  expect(new Set(graph.nodes.map((node) => node.trust.independenceGroup)).size).toBe(2);
});

test("historical and current evidence cannot merge", () => {
  const current = sampleNode({ identityKey: "region", producer: "chunker/v1", blob: "same" });
  const historical = sampleNode({
    identityKey: "abc123def456",
    producer: "git/v1",
    blob: "same",
    historical: true,
  });
  expect(isHistoricalNode(historical)).toBe(true);
  expect(isHistoricalNode(current)).toBe(false);
  const forced = {
    ...historical,
    id: current.id,
    kind: current.kind,
    identityKey: current.identityKey,
  };
  expect(() => mergeEvidenceNodes(current, forced)).toThrow(/historical and current/);
});

test("applyEvidenceDelta requires a matching base digest and preserves provenance", () => {
  const empty = emptyEvidenceGraph(SNAPSHOT_ID);
  const node = sampleNode({ identityKey: "seed", producer: "exact/v1", blob: "seed-body" });
  const delta = {
    schemaVersion: 1 as const,
    baseEvidenceGraphObjectDigest: evidenceGraphDigest(empty),
    nodes: [node],
    edges: [],
    unresolvedClaimIds: [],
    nextActions: [],
  };
  const graph = applyEvidenceDelta(empty, delta);
  expect(graph.nodes[0]?.provenance).toEqual(node.provenance);
  const again = {
    ...delta,
    baseEvidenceGraphObjectDigest: evidenceGraphDigest(graph),
    nodes: [sampleNode({ identityKey: "seed", producer: "second/v1", blob: "seed-body" })],
  };
  const secondNode = again.nodes[0];
  if (secondNode === undefined) {
    throw new Error("missing node");
  }
  const aliased = {
    ...secondNode,
    id: node.id,
    trust: { ...secondNode.trust, independenceGroup: node.trust.independenceGroup },
  };
  const merged = applyEvidenceDelta(graph, { ...again, nodes: [aliased] });
  expect(merged.nodes).toHaveLength(1);
  expect(merged.nodes[0]?.provenance.length).toBe(2);
});

test("edge identity is stable and provenance is required", () => {
  const from = sampleNode({ identityKey: "from", producer: "p/v1", blob: "a" });
  const to = sampleNode({ identityKey: "to", producer: "p/v1", blob: "b" });
  const edge = createEvidenceEdge({
    from: from.id,
    to: to.id,
    relation: "REFERENCES",
    polarity: "positive",
    confidence: 0.5,
    provenance: from.provenance,
  });
  const graph = mergeEvidence(emptyEvidenceGraph(SNAPSHOT_ID), [from, to], [edge]);
  assertEvidenceGraph(graph);
  expect(graph.edges[0]?.id).toBe(edge.id);
});

test("mergeProvenance is commutative", () => {
  assert(
    property(
      string({ minLength: 1, maxLength: 8 }),
      string({ minLength: 1, maxLength: 8 }),
      (leftLabel, rightLabel) => {
        const left = sampleNode({
          identityKey: "k",
          producer: `p-${leftLabel}/v1`,
          blob: "x",
        }).provenance;
        const right = sampleNode({
          identityKey: "k",
          producer: `p-${rightLabel}/v1`,
          blob: "x",
        }).provenance;
        const ab = mergeProvenance(left, right);
        const ba = mergeProvenance(right, left);
        expect(ab.map((item) => item.extractorId)).toEqual(ba.map((item) => item.extractorId));
      },
    ),
  );
});

test("dropping provenance fails graph invariants", () => {
  const node = sampleNode({ identityKey: "keep", producer: "p/v1", blob: "z" });
  const broken = { ...node, provenance: [] };
  expect(() => {
    assertEvidenceGraph({ schemaVersion: 1, snapshotId: SNAPSHOT_ID, nodes: [broken], edges: [] });
  }).toThrow(/provenance/);
});

test("observedAt is excluded from identity", () => {
  const first = sampleNode({ identityKey: "volatile", producer: "p/v1", blob: "v" });
  const second = {
    ...first,
    provenance: first.provenance.map((item) => ({
      ...item,
      observedAt: "2026-08-28T01:00:00.000Z",
    })),
  };
  expect(nodeIdentityId(SNAPSHOT_ID, second)).toBe(first.id);
  expect(second.provenance[0]?.observedAt).not.toBe(TS);
});
