import {
  asEvidenceId,
  asObjectDigest,
  asSnapshotId,
  sha256Utf8,
  type EvidenceGraph,
  type EvidenceId,
  type EvidenceNode,
  type EvidenceRelation,
  type RetrievalAction,
  type SnapshotId,
} from "@pi-hec/contracts";
import {
  artifactSourceRef,
  createEvidenceEdge,
  createEvidenceNode,
  defaultTrust,
  evidenceGraphDigest,
  independenceGroupFor,
  makeProvenance,
  mergeEvidence,
  repositorySourceRef,
} from "@pi-hec/evidence";
import type { ClosurePredicateId, ClosureTemplate } from "../src/closure/index.js";
import type { LocalSemanticAdapter } from "../src/local-session.js";
import type { PreflightTask } from "../src/orchestrator.js";
import { REQ, RUN, SNAP } from "./fixtures.js";

export const TS = "2026-08-28T00:00:00.000Z";

export const TASK: PreflightTask = {
  runId: RUN,
  snapshotId: SNAP,
  originalRequest: "fix the null deref in parse()",
  closureTemplate: "bug",
  requirements: [{ id: REQ, priority: "MUST", text: "parse must not throw on empty input" }],
};

export const INSTRUCTIONS = [{ path: "AGENTS.md", contentDigest: sha256Utf8("agents") }] as const;

export function requirementNodeId(graph: EvidenceGraph): EvidenceId {
  const node = graph.nodes.find((item) => item.kind === "requirement");
  if (node === undefined) {
    throw new Error("seed graph is missing a requirement node");
  }
  return asEvidenceId(node.id);
}

export function silentAdapter(
  propose: (lane: string) => readonly RetrievalAction[] = () => [],
): LocalSemanticAdapter {
  const digest = sha256Utf8("silent");
  return {
    expandRetrievalQueries: () =>
      Promise.resolve({ schemaVersion: 1, queries: [] }),
    proposeEvidenceActions: (request) =>
      Promise.resolve({
        schemaVersion: 1,
        evidenceGraphObjectDigest: request.evidenceGraphObjectDigest,
        actions: [...propose(request.lane)],
        fixedPointClaimed: true,
      }),
    linkEvidence: (request) =>
      Promise.resolve({
        schemaVersion: 1,
        evidenceGraphObjectDigest: request.evidenceGraphObjectDigest,
        proposedEvidence: [],
        proposedRelations: [],
      }),
    identifyUnknownsAndConflicts: (request) =>
      Promise.resolve({
        schemaVersion: 1,
        evidenceGraphObjectDigest: request.evidenceGraphObjectDigest,
        proposedUnknowns: [],
        proposedConflicts: [],
        closureCheckSuggestions: [],
      }),
    reviewCandidateAgainstEvidence: () =>
      Promise.resolve({
        schemaVersion: 1,
        candidateId: "candidate_01234567-89ab-7cde-8f01-23456789abcd",
        candidateManifestObjectDigest: digest,
        findings: [],
      }),
    dispose: () => Promise.resolve(),
  };
}

export function emptyDelta(graph: EvidenceGraph) {
  return {
    schemaVersion: 1 as const,
    baseEvidenceGraphObjectDigest: evidenceGraphDigest(graph),
    nodes: [],
    edges: [],
    unresolvedClaimIds: [] as EvidenceId[],
    nextActions: [] as RetrievalAction[],
  };
}

function fixtureNode(
  snapshotId: string,
  kind: Parameters<typeof createEvidenceNode>[0]["kind"],
  identityKey: string,
  status: Parameters<typeof createEvidenceNode>[0]["status"] = "verified",
  extractorId = "pi-hec-preflight-fixture/v1",
) {
  const digest = asObjectDigest(sha256Utf8(`fixture:${identityKey}:${extractorId}`));
  return createEvidenceNode({
    snapshotId: asSnapshotId(snapshotId),
    kind,
    identityKey,
    authorship: "DETERMINISTIC",
    label: identityKey.slice(0, 1024),
    contentObjectDigest: digest,
    status,
    trust: defaultTrust({
      independenceGroup: independenceGroupFor(extractorId, digest),
      authority: 1,
      directness: "observed",
    }),
    provenance: [
      makeProvenance({
        source: artifactSourceRef({
          artifactObjectDigest: digest,
          quoteDigest: digest,
          sourceKind: "runtime",
        }),
        extractorId,
        extractorVersion: "fixture/v1",
        observedAt: TS,
        contentDigest: digest,
      }),
    ],
    estimatedTokens: 1,
  });
}

export function satisfyingOverlay(seed: EvidenceGraph): EvidenceGraph {
  const requirement = seed.nodes.find((node) => node.kind === "requirement");
  if (requirement === undefined) {
    throw new Error("seed graph is missing a requirement node");
  }
  const requirementEvidenceId = asEvidenceId(requirement.id);
  const snapshotId = seed.snapshotId;
  const testNode = fixtureNode(snapshotId, "test", "test:parse-empty");
  const symbol = fixtureNode(snapshotId, "symbol", "symbol:parse");
  const symbolAlt = fixtureNode(
    snapshotId,
    "symbol",
    "symbol:parse",
    "verified",
    "pi-hec-preflight-fixture-b/v1",
  );
  const contract = fixtureNode(snapshotId, "api-contract", "contract:parse");
  const dependency = fixtureNode(snapshotId, "dependency", "dep:runtime@1.0.0");
  const consumer = fixtureNode(snapshotId, "symbol", "symbol:caller");
  const nodes = [testNode, symbol, symbolAlt, contract, dependency, consumer];
  const edgeProvenance = testNode.provenance;
  const edges = [
    createEvidenceEdge({
      from: requirementEvidenceId,
      to: testNode.id,
      relation: "COVERED_BY",
      polarity: "positive",
      confidence: 1,
      provenance: edgeProvenance,
    }),
    createEvidenceEdge({
      from: requirementEvidenceId,
      to: testNode.id,
      relation: "SATISFIES",
      polarity: "positive",
      confidence: 1,
      provenance: edgeProvenance,
    }),
    createEvidenceEdge({
      from: symbol.id,
      to: testNode.id,
      relation: "FLOWS_TO",
      polarity: "positive",
      confidence: 1,
      provenance: edgeProvenance,
    }),
    createEvidenceEdge({
      from: requirementEvidenceId,
      to: symbol.id,
      relation: "CANDIDATE_LOCUS",
      polarity: "positive",
      confidence: 1,
      provenance: edgeProvenance,
    }),
    createEvidenceEdge({
      from: consumer.id,
      to: symbolAlt.id,
      relation: "CANDIDATE_LOCUS",
      polarity: "positive",
      confidence: 1,
      provenance: edgeProvenance,
    }),
    createEvidenceEdge({
      from: consumer.id,
      to: symbol.id,
      relation: "REFERENCES",
      polarity: "positive",
      confidence: 1,
      provenance: edgeProvenance,
    }),
    createEvidenceEdge({
      from: contract.id,
      to: symbol.id,
      relation: "SUPPORTS",
      polarity: "positive",
      confidence: 1,
      provenance: edgeProvenance,
    }),
  ];
  return mergeEvidence(seed, nodes, edges);
}

export function channelLocusDelta(
  graph: EvidenceGraph,
  snapshotId: SnapshotId,
  requirementEvidenceId: EvidenceId,
  channelId: string,
  identityKey: string,
) {
  const digest = asObjectDigest(sha256Utf8("shared-locus-parse"));
  const extractorId = `pi-hec-channel-${channelId}/v1`;
  const node = createEvidenceNode({
    snapshotId,
    kind: "symbol",
    identityKey,
    authorship: "DETERMINISTIC",
    label: identityKey.slice(0, 1024),
    contentObjectDigest: digest,
    status: "probable",
    trust: defaultTrust({
      independenceGroup: independenceGroupFor(extractorId, digest),
      authority: 0.7,
      directness: "static-derived",
    }),
    provenance: [
      makeProvenance({
        source: repositorySourceRef({
          snapshotId,
          artifactObjectDigest: digest,
          path: `src/parse-${channelId}.ts`,
          quoteDigest: digest,
        }),
        extractorId,
        extractorVersion: "expand/v1",
        observedAt: TS,
        contentDigest: digest,
      }),
    ],
    estimatedTokens: 1,
  });
  const edge = createEvidenceEdge({
    from: requirementEvidenceId,
    to: node.id,
    relation: "CANDIDATE_LOCUS",
    polarity: "positive",
    confidence: 0.7,
    provenance: node.provenance,
  });
  return {
    schemaVersion: 1 as const,
    baseEvidenceGraphObjectDigest: evidenceGraphDigest(graph),
    nodes: [node],
    edges: [edge],
    unresolvedClaimIds: [] as EvidenceId[],
    nextActions: [] as RetrievalAction[],
  };
}

function retainGraph(
  graph: EvidenceGraph,
  keepNode: (node: EvidenceNode) => boolean,
  keepEdge: (relation: EvidenceRelation) => boolean = () => true,
): EvidenceGraph {
  const nodes = graph.nodes.filter(keepNode);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => keepEdge(edge.relation) && ids.has(edge.from) && ids.has(edge.to),
  );
  return { schemaVersion: 1, snapshotId: graph.snapshotId, nodes, edges };
}

export function refactorOverlay(seed: EvidenceGraph): EvidenceGraph {
  const base = satisfyingOverlay(seed);
  const invariant = fixtureNode(seed.snapshotId, "invariant", "invariant:parse-empty");
  return mergeEvidence(base, [invariant], []);
}

export function investigationOverlay(seed: EvidenceGraph): EvidenceGraph {
  const base = satisfyingOverlay(seed);
  const boundary = fixtureNode(seed.snapshotId, "constraint", "uncertainty-boundary:parse-empty");
  const scan = fixtureNode(seed.snapshotId, "fact", "contradiction-scan:parse-empty");
  return mergeEvidence(base, [boundary, scan], []);
}

export function overlayFor(template: ClosureTemplate, seed: EvidenceGraph): EvidenceGraph {
  switch (template) {
    case "bug":
    case "feature":
      return satisfyingOverlay(seed);
    case "refactor":
      return refactorOverlay(seed);
    case "investigation":
      return investigationOverlay(seed);
    default: {
      const exhaustive: never = template;
      throw new Error(`unhandled closure template ${String(exhaustive)}`);
    }
  }
}

export function mixedDependencyOverlay(seed: EvidenceGraph): EvidenceGraph {
  const base = satisfyingOverlay(seed);
  const unverified = fixtureNode(seed.snapshotId, "dependency", "dep:unverified@0.0.1", "probable");
  return mergeEvidence(base, [unverified], []);
}

export function instructionScopedLocusOverlay(seed: EvidenceGraph): EvidenceGraph {
  const overlay = satisfyingOverlay(seed);
  const instruction = overlay.nodes.find((node) => node.kind === "instruction");
  const symbol = overlay.nodes.find((node) => node.identityKey === "symbol:parse");
  if (instruction === undefined || symbol === undefined) {
    throw new Error("instruction-scoped overlay requires an instruction and a parse locus");
  }
  const kept = overlay.edges.filter((edge) => edge.relation !== "CANDIDATE_LOCUS");
  const locus = createEvidenceEdge({
    from: instruction.id,
    to: symbol.id,
    relation: "CANDIDATE_LOCUS",
    polarity: "positive",
    confidence: 1,
    provenance: instruction.provenance,
  });
  return { schemaVersion: 1, snapshotId: overlay.snapshotId, nodes: overlay.nodes, edges: [...kept, locus] };
}

export function createdClaimDelta(graph: EvidenceGraph, snapshotId: SnapshotId, identityKey: string) {
  const node = fixtureNode(snapshotId, "fact", identityKey);
  return {
    nodeId: node.id,
    delta: {
      schemaVersion: 1 as const,
      baseEvidenceGraphObjectDigest: evidenceGraphDigest(graph),
      nodes: [node],
      edges: [],
      unresolvedClaimIds: [] as EvidenceId[],
      nextActions: [] as RetrievalAction[],
    },
  };
}

export function graphMissingPredicate(graph: EvidenceGraph, predicateId: ClosurePredicateId): EvidenceGraph {
  switch (predicateId) {
    case "symptom":
      return retainGraph(graph, (node) => node.kind !== "task" && node.kind !== "requirement");
    case "reproducible-observation":
      return retainGraph(graph, (node) => node.kind !== "test" && node.kind !== "test-result");
    case "execution-path":
      return retainGraph(graph, (node) => node.kind !== "stack-frame", (relation) => relation !== "FLOWS_TO");
    case "responsible-boundary":
      return retainGraph(
        graph,
        (node) => node.kind !== "api-contract" && node.kind !== "symbol",
        (relation) => relation !== "CANDIDATE_LOCUS",
      );
    case "affected-contract":
      return retainGraph(graph, (node) => node.kind !== "api-contract" && node.kind !== "schema");
    case "regression-witness":
      return retainGraph(graph, () => true, (relation) => relation !== "COVERED_BY");
    case "requirement":
      return retainGraph(graph, (node) => node.kind !== "requirement");
    case "public-internal-contract":
      return retainGraph(graph, (node) => node.kind !== "api-contract" && node.kind !== "schema");
    case "insertion-boundaries":
      return retainGraph(graph, () => true, (relation) => relation !== "CANDIDATE_LOCUS");
    case "existing-patterns":
      return retainGraph(graph, (node) => node.kind !== "symbol" && node.kind !== "code-region");
    case "consumers":
      return retainGraph(graph, (node) => node.kind !== "symbol", (relation) => relation !== "REFERENCES");
    case "verification-capabilities":
      return retainGraph(graph, (node) => node.kind !== "test" && node.kind !== "test-result");
    case "behavioral-invariants":
      return retainGraph(graph, (node) => node.kind !== "invariant" && node.kind !== "constraint");
    case "dependency-boundary":
      return retainGraph(graph, (node) => node.kind !== "dependency");
    case "reverse-dependencies":
      return retainGraph(graph, () => true, (relation) => relation !== "REFERENCES");
    case "compatibility-surface":
      return retainGraph(graph, (node) => node.kind !== "api-contract" && node.kind !== "schema");
    case "preserving-tests":
      return retainGraph(graph, (node) => node.kind !== "test", (relation) => relation !== "COVERED_BY");
    case "claim":
      return retainGraph(
        graph,
        (node) => node.kind !== "fact" && node.kind !== "hypothesis" && node.kind !== "task",
      );
    case "authoritative-evidence":
      return retainGraph(graph, () => true, (relation) => relation !== "SUPPORTS");
    case "contradicting-evidence":
      return retainGraph(
        graph,
        (node) => node.kind !== "conflict" && !node.identityKey.startsWith("contradiction-scan:"),
        (relation) => relation !== "CONTRADICTS",
      );
    case "uncertainty-boundary":
      return retainGraph(
        graph,
        (node) => node.kind !== "unknown" && !node.identityKey.startsWith("uncertainty-boundary:"),
      );
    case "reproducible-explanation":
      return retainGraph(
        graph,
        (node) => node.kind !== "test-result" && node.kind !== "stack-frame",
        (relation) => relation !== "FLOWS_TO",
      );
    default: {
      const exhaustive: never = predicateId;
      throw new Error(`unhandled closure predicate ${String(exhaustive)}`);
    }
  }
}
