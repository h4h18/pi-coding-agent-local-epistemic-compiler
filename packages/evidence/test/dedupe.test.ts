import { expect, test } from "vitest";
import { astFingerprintFor, dedupeEvidence, fqSignatureFor, normalizedTextDigest } from "../src/dedupe.js";
import {
  assertEvidenceGraph,
  createEvidenceEdge,
  emptyEvidenceGraph,
  mergeEvidence,
} from "../src/graph.js";
import { SNAPSHOT_ID, sampleNode, sampleSubject } from "./helpers.js";

test("dedupe sequence 17.6: exact blob hash merges same producer", () => {
  const left = sampleNode({ identityKey: "one", producer: "chunker/v1", blob: "duplicate" });
  const right = sampleNode({ identityKey: "two", producer: "chunker/v1", blob: "duplicate" });
  const result = dedupeEvidence(
    [
      sampleSubject(left, { producer: "chunker/v1", path: "src/a.ts", blobDigest: left.contentObjectDigest ?? "" }),
      sampleSubject(right, { producer: "chunker/v1", path: "src/b.ts", blobDigest: right.contentObjectDigest ?? "" }),
    ],
    [],
  );
  expect(result.nodes).toHaveLength(1);
  expect(result.nodes[0]?.provenance.length).toBe(2);
});

test("exact hash does not fake independence across producers", () => {
  const left = sampleNode({ identityKey: "one", producer: "alpha/v1", blob: "duplicate" });
  const right = sampleNode({ identityKey: "two", producer: "beta/v1", blob: "duplicate" });
  const result = dedupeEvidence(
    [
      sampleSubject(left, { producer: "alpha/v1", path: "src/a.ts", blobDigest: left.contentObjectDigest ?? "" }),
      sampleSubject(right, { producer: "beta/v1", path: "src/b.ts", blobDigest: right.contentObjectDigest ?? "" }),
    ],
    [],
  );
  expect(result.nodes).toHaveLength(2);
  expect(new Set(result.nodes.map((node) => node.trust.independenceGroup)).size).toBe(2);
});

test("SCIP symbol merge is blocked for overloads", () => {
  const left = sampleNode({ identityKey: "add-a", producer: "chunker/v1", blob: "add-int" });
  const right = sampleNode({ identityKey: "add-b", producer: "chunker/v1", blob: "add-str" });
  const result = dedupeEvidence(
    [
      sampleSubject(left, {
        producer: "chunker/v1",
        path: "src/math.ts",
        scipSymbolId: "scip:add",
        overloadKey: "add:int",
        fqSignature: "add(int)",
      }),
      sampleSubject(right, {
        producer: "chunker/v1",
        path: "src/math.ts",
        scipSymbolId: "scip:add",
        overloadKey: "add:string",
        fqSignature: "add(string)",
      }),
    ],
    [],
  );
  expect(result.nodes).toHaveLength(2);
});

test("overload mismatch blocks AST and near-clone merge", () => {
  const left = sampleNode({ identityKey: "ov-ast-a", producer: "chunker/v1", blob: "ov-body-a" });
  const right = sampleNode({ identityKey: "ov-ast-b", producer: "chunker/v1", blob: "ov-body-b" });
  const digest = normalizedTextDigest("shared clone body");
  const result = dedupeEvidence(
    [
      sampleSubject(left, {
        producer: "chunker/v1",
        path: "src/ov-a.ts",
        blobDigest: "blob-ov-a",
        astFingerprint: "same-ast-tree",
        overloadKey: "add:int",
        normalizedTextDigest: digest,
      }),
      sampleSubject(right, {
        producer: "chunker/v1",
        path: "src/ov-b.ts",
        blobDigest: "blob-ov-b",
        astFingerprint: "same-ast-tree",
        overloadKey: "add:string",
        normalizedTextDigest: digest,
      }),
    ],
    [],
  );
  expect(result.nodes).toHaveLength(2);
});

test("normalized AST fingerprint merges when not blocked", () => {
  const left = sampleNode({ identityKey: "ast-a", producer: "chunker/v1", blob: "body-a" });
  const right = sampleNode({ identityKey: "ast-b", producer: "chunker/v1", blob: "body-b" });
  const result = dedupeEvidence(
    [
      sampleSubject(left, {
        producer: "chunker/v1",
        path: "src/a.ts",
        astFingerprint: "ast-finger-1",
      }),
      sampleSubject(right, {
        producer: "chunker/v1",
        path: "src/b.ts",
        astFingerprint: "ast-finger-1",
      }),
    ],
    [],
  );
  expect(result.nodes).toHaveLength(1);
});

test("interval containment merges the nested region of the same kind", () => {
  const outer = sampleNode({
    identityKey: "outer",
    producer: "chunker/v1",
    blob: "outer-body",
    byteStart: 0,
    byteEnd: 100,
  });
  const inner = sampleNode({
    identityKey: "inner",
    producer: "chunker/v1",
    blob: "inner-body",
    byteStart: 10,
    byteEnd: 20,
  });
  const result = dedupeEvidence(
    [
      sampleSubject(outer, { producer: "chunker/v1", path: "src/file.ts", byteStart: 0, byteEnd: 100 }),
      sampleSubject(inner, { producer: "chunker/v1", path: "src/file.ts", byteStart: 10, byteEnd: 20 }),
    ],
    [],
  );
  expect(result.nodes).toHaveLength(1);
});

test("near-clone requires matching directory scope", () => {
  const left = sampleNode({ identityKey: "clone-a", producer: "chunker/v1", blob: "clone-text" });
  const right = sampleNode({ identityKey: "clone-b", producer: "chunker/v1", blob: "clone-text" });
  const digest = normalizedTextDigest("clone-text");
  const sameDir = dedupeEvidence(
    [
      sampleSubject(left, {
        producer: "chunker/v1",
        path: "src/a.ts",
        blobDigest: "distinct-a",
        normalizedTextDigest: digest,
      }),
      sampleSubject(right, {
        producer: "chunker/v1",
        path: "src/b.ts",
        blobDigest: "distinct-b",
        normalizedTextDigest: digest,
      }),
    ],
    [],
  );
  expect(sameDir.nodes).toHaveLength(1);
  const crossDir = dedupeEvidence(
    [
      sampleSubject(left, {
        producer: "chunker/v1",
        path: "src/a.ts",
        blobDigest: "distinct-a",
        normalizedTextDigest: digest,
      }),
      sampleSubject(right, {
        producer: "chunker/v1",
        path: "other/b.ts",
        blobDigest: "distinct-b",
        normalizedTextDigest: digest,
      }),
    ],
    [],
  );
  expect(crossDir.nodes).toHaveLength(2);
});

test("historical versus current evidence never collapses even with the same blob", () => {
  const current = sampleNode({ identityKey: "now", producer: "chunker/v1", blob: "payload" });
  const historical = sampleNode({
    identityKey: "then",
    producer: "chunker/v1",
    blob: "payload",
    historical: true,
  });
  const result = dedupeEvidence(
    [
      sampleSubject(current, {
        producer: "chunker/v1",
        path: "src/now.ts",
        blobDigest: current.contentObjectDigest ?? "",
      }),
      sampleSubject(historical, {
        producer: "chunker/v1",
        path: ".git/commits/then",
        blobDigest: historical.contentObjectDigest ?? "",
      }),
    ],
    [],
  );
  expect(result.nodes).toHaveLength(2);
});

test("generated specializations do not merge across paths", () => {
  const left = sampleNode({ identityKey: "gen-a", producer: "chunker/v1", blob: "gen" });
  const right = sampleNode({ identityKey: "gen-b", producer: "chunker/v1", blob: "gen" });
  const result = dedupeEvidence(
    [
      sampleSubject(left, {
        producer: "chunker/v1",
        path: "src/a.ts",
        blobDigest: left.contentObjectDigest ?? "",
        generated: true,
      }),
      sampleSubject(right, {
        producer: "chunker/v1",
        path: "generated/a.ts",
        blobDigest: right.contentObjectDigest ?? "",
        generated: true,
      }),
    ],
    [],
  );
  expect(result.nodes).toHaveLength(2);
});

test("fq signature is not the AST fingerprint", () => {
  const fq = fqSignatureFor("add", "iface-digest");
  const ast = astFingerprintFor({
    kind: "function",
    language: "typescript",
    symbolId: "add",
    text: "export function add() { return 1; }",
    parentHierarchy: JSON.stringify(["src/math.ts"]),
  });
  expect(fq).not.toBe("");
  expect(ast).not.toBe("");
  expect(fq).not.toBe(ast);
});

test("SCIP and AST merge refuse different historical revisions", () => {
  const left = sampleNode({
    identityKey: "rev-a",
    producer: "git/v1",
    blob: "patch-a",
    historical: true,
  });
  const right = sampleNode({
    identityKey: "rev-b",
    producer: "git/v1",
    blob: "patch-b",
    historical: true,
  });
  const result = dedupeEvidence(
    [
      sampleSubject(left, {
        producer: "git/v1",
        path: ".git/commits/rev-a.diff",
        blobDigest: left.contentObjectDigest ?? "",
        scipSymbolId: "scip:same",
        fqSignature: "same-fq",
        astFingerprint: "same-ast",
        overloadKey: "same-overload",
      }),
      sampleSubject(right, {
        producer: "git/v1",
        path: ".git/commits/rev-b.diff",
        blobDigest: right.contentObjectDigest ?? "",
        scipSymbolId: "scip:same",
        fqSignature: "same-fq",
        astFingerprint: "same-ast",
        overloadKey: "same-overload",
      }),
    ],
    [],
  );
  expect(result.nodes).toHaveLength(2);
});

test("cross-path AST merge remaps edges onto the survivor", () => {
  const left = sampleNode({ identityKey: "ast-keep", producer: "chunker/v1", blob: "body-keep" });
  const right = sampleNode({ identityKey: "ast-drop", producer: "chunker/v1", blob: "body-drop" });
  const other = sampleNode({ identityKey: "ast-other", producer: "chunker/v1", blob: "body-other" });
  const edge = createEvidenceEdge({
    from: right.id,
    to: other.id,
    relation: "REFERENCES",
    polarity: "positive",
    confidence: 0.7,
    provenance: right.provenance,
  });
  const between = createEvidenceEdge({
    from: left.id,
    to: right.id,
    relation: "CONTAINS",
    polarity: "positive",
    confidence: 0.5,
    provenance: left.provenance,
  });
  const result = dedupeEvidence(
    [
      sampleSubject(left, {
        producer: "chunker/v1",
        path: "src/keep.ts",
        astFingerprint: "shared-tree",
      }),
      sampleSubject(right, {
        producer: "chunker/v1",
        path: "src/drop.ts",
        astFingerprint: "shared-tree",
      }),
      sampleSubject(other, {
        producer: "chunker/v1",
        path: "src/other.ts",
        astFingerprint: "unique-tree",
      }),
    ],
    [edge, between],
  );
  expect(result.nodes).toHaveLength(2);
  expect(result.nodes.some((node) => node.id === other.id)).toBe(true);
  const survivor = result.nodes.find((node) => node.id !== other.id);
  if (survivor === undefined) {
    throw new Error("missing AST merge survivor");
  }
  expect(result.edges).toHaveLength(1);
  expect(result.edges[0]?.from).toBe(survivor.id);
  expect(result.edges[0]?.to).toBe(other.id);
  const graph = mergeEvidence(emptyEvidenceGraph(SNAPSHOT_ID), result.nodes, result.edges);
  assertEvidenceGraph(graph);
});
