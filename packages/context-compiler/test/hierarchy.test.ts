import { expect, test } from "vitest";
import {
  compareUtf8,
  createEvidenceEdge,
  createEvidenceNode,
  defaultTrust,
  independenceGroupFor,
} from "@pi-hec/evidence";
import { compileCloudContext } from "../src/index.js";
import {
  SNAP,
  SOURCE_BODY,
  compilerInput,
  digestOf,
  nodeProvenance,
  payloadFor,
  buildWorld,
} from "./fixtures.js";

test("exact code evidence serializes directory-file-symbol-region even when ids sort opposite", () => {
  const world = buildWorld();
  const fileNode = world.graph.nodes.find((node) => node.kind === "file");
  let symbolNode;
  for (let index = 0; index < 64; index += 1) {
    const candidate = createEvidenceNode({
      snapshotId: SNAP,
      kind: "symbol",
      identityKey: `symbol:src/parse.ts:0:4:parse:v${String(index)}`,
      authorship: "DETERMINISTIC",
      label: "parse",
      status: "verified",
      contentObjectDigest: digestOf(`${SOURCE_BODY}:${String(index)}`),
      trust: defaultTrust({
        independenceGroup: independenceGroupFor("indexer", `symbol-${String(index)}`),
      }),
      provenance: nodeProvenance("src/parse.ts", SOURCE_BODY),
      estimatedTokens: 8,
    });
    if (fileNode !== undefined && compareUtf8(candidate.id, fileNode.id) < 0) {
      symbolNode = candidate;
      break;
    }
  }
  expect(fileNode).toBeDefined();
  expect(symbolNode).toBeDefined();
  if (fileNode === undefined || symbolNode === undefined) {
    return;
  }
  expect(compareUtf8(symbolNode.id, fileNode.id)).toBeLessThan(0);
  const edge = createEvidenceEdge({
    from: fileNode.id,
    to: symbolNode.id,
    relation: "DEFINES",
    polarity: "positive",
    confidence: 1,
    provenance: nodeProvenance("src/parse.ts", SOURCE_BODY),
  });
  const witness = world.bundles[0];
  if (witness === undefined) {
    return;
  }
  const bundles = [
    {
      ...witness,
      nodeIds: [...witness.nodeIds, symbolNode.id],
      edgeIds: [...witness.edgeIds, edge.id],
    },
    ...world.bundles.slice(1),
  ];
  const outcome = compileCloudContext(
    compilerInput({
      graph: {
        ...world.graph,
        nodes: [...world.graph.nodes, symbolNode],
        edges: [...world.graph.edges, edge],
      },
      bundles,
      payloads: [
        ...world.payloads,
        payloadFor(symbolNode, "src/parse.ts", "export function parse"),
      ],
    }),
  );
  expect(outcome.kind).toBe("compiled");
  if (outcome.kind !== "compiled") {
    return;
  }
  const user = outcome.artifacts.conversation.messages[0];
  const text = user?.content[0];
  if (text?.kind !== "text") {
    return;
  }
  const start = text.text.indexOf("## 6. Exact code/test/config evidence");
  const end = text.text.indexOf("## 7. Runtime/history/external docs");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const section = text.text.slice(start, end);
  const fileIndex = section.indexOf(fileNode.id);
  const symbolIndex = section.indexOf(symbolNode.id);
  expect(fileIndex).toBeGreaterThan(-1);
  expect(symbolIndex).toBeGreaterThan(-1);
  expect(fileIndex).toBeLessThan(symbolIndex);
});
