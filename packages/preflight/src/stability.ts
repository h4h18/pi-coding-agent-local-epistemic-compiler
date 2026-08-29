import type { EvidenceGraph, EvidenceId, EvidenceNode, RetrievalAction, SnapshotId } from "@pi-hec/contracts";
import {
  actionCanonicalDigest,
  asEvidenceId,
  asSnapshotId,
  compareUtf8,
  normalizeQuery,
  type RetrievalChannelId,
} from "@pi-hec/evidence";
import { digestCanonical } from "./closure/evaluate.js";
import { instructionNodes } from "./closure/templates.js";

export type CriticalFacets = {
  loci: readonly string[];
  instructionIds: readonly EvidenceId[];
  proofObligationKeys: readonly string[];
};

export type StabilityAudit = {
  stable: boolean;
  paraphraseStable: boolean;
  channelDropoutStable: boolean;
  permutationStable: boolean;
  sourceIndependenceStable: boolean;
  instructionScopeStable: boolean;
  facets: CriticalFacets;
};

function retainNodes(graph: EvidenceGraph, keep: (node: EvidenceNode) => boolean): EvidenceGraph {
  const nodes = graph.nodes.filter(keep);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  return { schemaVersion: 1, snapshotId: graph.snapshotId, nodes, edges };
}

function locusIdentityKeys(graph: EvidenceGraph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const keys = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.relation !== "CANDIDATE_LOCUS") {
      continue;
    }
    const target = byId.get(edge.to);
    if (target !== undefined) {
      keys.add(target.identityKey);
    }
  }
  return [...keys].sort(compareUtf8);
}

export function compileCriticalFacets(
  graph: EvidenceGraph,
  proofObligationKeys: readonly string[],
): CriticalFacets {
  return {
    loci: locusIdentityKeys(graph),
    instructionIds: instructionNodes(graph)
      .map((node) => asEvidenceId(node.id))
      .sort(compareUtf8),
    proofObligationKeys: [...proofObligationKeys].sort(compareUtf8),
  };
}

export function facetsEqual(left: CriticalFacets, right: CriticalFacets): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function paraphraseQueries(query: string): readonly string[] {
  const normalized = normalizeQuery(query);
  const variants: string[] = [];
  const add = (value: string): void => {
    if (value.length > 0 && value !== normalized && !variants.includes(value)) {
      variants.push(value);
    }
  };
  add(` ${query} `);
  add(query.replace(/\s+/gu, "  "));
  const nfc = query.normalize("NFC");
  const nfd = query.normalize("NFD");
  if (nfc !== nfd) {
    add(nfc);
    add(nfd);
  }
  return variants;
}

export function paraphraseStable(
  snapshotId: SnapshotId,
  actions: readonly Pick<RetrievalAction, "channelId" | "query" | "filters">[],
): boolean {
  for (const action of actions) {
    const canonical = actionCanonicalDigest(snapshotId, action);
    for (const variant of paraphraseQueries(action.query)) {
      if (actionCanonicalDigest(snapshotId, { ...action, query: variant }) !== canonical) {
        return false;
      }
    }
  }
  return true;
}

function extractorChannel(extractorId: string): string | undefined {
  const match = /^pi-hec-channel-([^/]+)\/v1$/u.exec(extractorId);
  return match?.[1];
}

export function graphWithoutChannel(graph: EvidenceGraph, channelId: string): EvidenceGraph {
  return retainNodes(graph, (node) =>
    node.provenance.some((item) => extractorChannel(item.extractorId) !== channelId),
  );
}

export function graphWithoutIndependenceGroup(graph: EvidenceGraph, group: string): EvidenceGraph {
  return retainNodes(graph, (node) => node.trust.independenceGroup !== group);
}

export function graphWithoutInstructions(graph: EvidenceGraph): EvidenceGraph {
  return retainNodes(graph, (node) => node.kind !== "instruction");
}

function reversedGraph(graph: EvidenceGraph): EvidenceGraph {
  return {
    schemaVersion: 1,
    snapshotId: graph.snapshotId,
    nodes: [...graph.nodes].reverse(),
    edges: [...graph.edges].reverse(),
  };
}

export function sourceIndependenceGroups(graph: EvidenceGraph): readonly string[] {
  return [...new Set(graph.nodes.map((node) => node.trust.independenceGroup))].sort(compareUtf8);
}

export function auditStability(input: {
  graph: EvidenceGraph;
  previous?: CriticalFacets;
  actions: readonly Pick<RetrievalAction, "channelId" | "query" | "filters">[];
  proofObligationKeys: readonly string[];
  retrievalChannelIds: readonly RetrievalChannelId[];
}): StabilityAudit {
  const facets = compileCriticalFacets(input.graph, input.proofObligationKeys);
  const paraphrase = paraphraseStable(asSnapshotId(input.graph.snapshotId), input.actions);
  let dropoutStable = true;
  for (const channelId of input.retrievalChannelIds) {
    const dropped = compileCriticalFacets(graphWithoutChannel(input.graph, channelId), input.proofObligationKeys);
    if (!sameKeys(facets.loci, dropped.loci) || !sameKeys(facets.proofObligationKeys, dropped.proofObligationKeys)) {
      dropoutStable = false;
      break;
    }
  }
  const permutationStable = facetsEqual(
    facets,
    compileCriticalFacets(reversedGraph(input.graph), input.proofObligationKeys),
  );
  let sourceIndependenceStable = true;
  for (const group of sourceIndependenceGroups(input.graph)) {
    const dropped = compileCriticalFacets(
      graphWithoutIndependenceGroup(input.graph, group),
      input.proofObligationKeys,
    );
    if (!sameKeys(facets.loci, dropped.loci) || !sameKeys(facets.proofObligationKeys, dropped.proofObligationKeys)) {
      sourceIndependenceStable = false;
      break;
    }
  }
  const scoped = compileCriticalFacets(graphWithoutInstructions(input.graph), input.proofObligationKeys);
  const instructionScopeStable =
    sameKeys(facets.loci, scoped.loci) && sameKeys(facets.proofObligationKeys, scoped.proofObligationKeys);
  const compared = input.previous === undefined || facetsEqual(input.previous, facets);
  return {
    stable:
      paraphrase &&
      dropoutStable &&
      permutationStable &&
      sourceIndependenceStable &&
      instructionScopeStable &&
      compared,
    paraphraseStable: paraphrase,
    channelDropoutStable: dropoutStable,
    permutationStable,
    sourceIndependenceStable,
    instructionScopeStable,
    facets,
  };
}

export function stabilityAuditDigest(audit: StabilityAudit): ReturnType<typeof digestCanonical> {
  return digestCanonical({
    stable: audit.stable,
    paraphraseStable: audit.paraphraseStable,
    channelDropoutStable: audit.channelDropoutStable,
    permutationStable: audit.permutationStable,
    sourceIndependenceStable: audit.sourceIndependenceStable,
    instructionScopeStable: audit.instructionScopeStable,
    facets: audit.facets,
  });
}
