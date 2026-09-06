import type { EvidenceGraph, EvidenceId, EvidenceNode, EvidenceRelation } from "@pi-hec/contracts";
import { asEvidenceId } from "@pi-hec/evidence";

export const CLOSURE_TEMPLATES = ["bug", "feature", "refactor", "investigation"] as const;
export type ClosureTemplate = (typeof CLOSURE_TEMPLATES)[number];

export type ClosurePredicateId =
  | "symptom"
  | "reproducible-observation"
  | "execution-path"
  | "responsible-boundary"
  | "affected-contract"
  | "regression-witness"
  | "requirement"
  | "public-internal-contract"
  | "insertion-boundaries"
  | "existing-patterns"
  | "consumers"
  | "verification-capabilities"
  | "behavioral-invariants"
  | "dependency-boundary"
  | "reverse-dependencies"
  | "compatibility-surface"
  | "preserving-tests"
  | "claim"
  | "authoritative-evidence"
  | "contradicting-evidence"
  | "uncertainty-boundary"
  | "reproducible-explanation";

export type ClosurePredicate = {
  id: ClosurePredicateId;
  satisfied: (graph: EvidenceGraph) => boolean;
};

const KIND =
  (kinds: ReadonlySet<EvidenceNode["kind"]>) =>
  (graph: EvidenceGraph): boolean =>
    graph.nodes.some((node) => kinds.has(node.kind) && node.authorship === "DETERMINISTIC");

const RELATION =
  (relation: EvidenceRelation) =>
  (graph: EvidenceGraph): boolean =>
    graph.edges.some((edge) => edge.relation === relation);

const KIND_OR_RELATION =
  (kinds: ReadonlySet<EvidenceNode["kind"]>, relation: EvidenceRelation) =>
  (graph: EvidenceGraph): boolean =>
    KIND(kinds)(graph) || RELATION(relation)(graph);

export const BUG_PREDICATES: readonly ClosurePredicate[] = [
  { id: "symptom", satisfied: KIND(new Set(["task", "requirement"])) },
  { id: "reproducible-observation", satisfied: KIND(new Set(["test", "test-result"])) },
  {
    id: "execution-path",
    satisfied: KIND_OR_RELATION(new Set(["stack-frame"]), "FLOWS_TO"),
  },
  {
    id: "responsible-boundary",
    satisfied: KIND_OR_RELATION(new Set(["api-contract", "symbol"]), "CANDIDATE_LOCUS"),
  },
  { id: "affected-contract", satisfied: KIND(new Set(["api-contract", "schema"])) },
  { id: "regression-witness", satisfied: RELATION("COVERED_BY") },
];

export const FEATURE_PREDICATES: readonly ClosurePredicate[] = [
  { id: "requirement", satisfied: KIND(new Set(["requirement"])) },
  { id: "public-internal-contract", satisfied: KIND(new Set(["api-contract", "schema"])) },
  { id: "insertion-boundaries", satisfied: RELATION("CANDIDATE_LOCUS") },
  { id: "existing-patterns", satisfied: KIND(new Set(["symbol", "code-region"])) },
  { id: "consumers", satisfied: KIND_OR_RELATION(new Set(["symbol"]), "REFERENCES") },
  { id: "verification-capabilities", satisfied: KIND(new Set(["test", "test-result"])) },
];

export const REFACTOR_PREDICATES: readonly ClosurePredicate[] = [
  { id: "behavioral-invariants", satisfied: KIND(new Set(["invariant", "constraint"])) },
  { id: "dependency-boundary", satisfied: KIND(new Set(["dependency"])) },
  { id: "reverse-dependencies", satisfied: RELATION("REFERENCES") },
  { id: "compatibility-surface", satisfied: KIND(new Set(["api-contract", "schema"])) },
  { id: "preserving-tests", satisfied: KIND_OR_RELATION(new Set(["test"]), "COVERED_BY") },
];

export const INVESTIGATION_PREDICATES: readonly ClosurePredicate[] = [
  { id: "claim", satisfied: KIND(new Set(["fact", "hypothesis", "task"])) },
  { id: "authoritative-evidence", satisfied: RELATION("SUPPORTS") },
  {
    id: "contradicting-evidence",
    satisfied: (graph) =>
      RELATION("CONTRADICTS")(graph) ||
      graph.nodes.some(
        (node) =>
          node.authorship === "DETERMINISTIC" &&
          node.kind === "fact" &&
          node.identityKey.startsWith("contradiction-scan:"),
      ),
  },
  {
    id: "uncertainty-boundary",
    satisfied: (graph) =>
      graph.nodes.some(
        (node) =>
          node.authorship === "DETERMINISTIC" &&
          (node.kind === "constraint" || node.kind === "fact") &&
          node.identityKey.startsWith("uncertainty-boundary:"),
      ),
  },
  {
    id: "reproducible-explanation",
    satisfied: KIND_OR_RELATION(new Set(["test-result", "stack-frame"]), "FLOWS_TO"),
  },
];

export function predicatesFor(template: ClosureTemplate): readonly ClosurePredicate[] {
  switch (template) {
    case "bug":
      return BUG_PREDICATES;
    case "feature":
      return FEATURE_PREDICATES;
    case "refactor":
      return REFACTOR_PREDICATES;
    case "investigation":
      return INVESTIGATION_PREDICATES;
    default: {
      const exhaustive: never = template;
      throw new Error(`unhandled closure template ${String(exhaustive)}`);
    }
  }
}

export function allTemplatePredicatesPass(
  template: ClosureTemplate,
  graph: EvidenceGraph,
): boolean {
  return predicatesFor(template).every((predicate) => predicate.satisfied(graph));
}

export function isCapabilityNode(node: EvidenceNode): boolean {
  return (
    node.identityKey.startsWith("channel-capability:") ||
    node.identityKey.startsWith("channel-failure:")
  );
}

export function factUnknowns(graph: EvidenceGraph): EvidenceNode[] {
  return graph.nodes.filter(
    (node) =>
      (node.kind === "unknown" || node.status === "unknown") &&
      !isCapabilityNode(node) &&
      node.authorship !== "LOCAL_MODEL",
  );
}

export function criticalConflicts(graph: EvidenceGraph): EvidenceNode[] {
  return graph.nodes.filter((node) => node.kind === "conflict" || node.status === "conflicted");
}

export function instructionNodes(graph: EvidenceGraph): EvidenceNode[] {
  return graph.nodes.filter((node) => node.kind === "instruction");
}

export function dependencyNodes(graph: EvidenceGraph): EvidenceNode[] {
  return graph.nodes.filter((node) => node.kind === "dependency");
}

export function locusNodeIds(graph: EvidenceGraph): EvidenceId[] {
  const ids = new Set<EvidenceId>();
  for (const edge of graph.edges) {
    if (edge.relation === "CANDIDATE_LOCUS") {
      ids.add(asEvidenceId(edge.to));
      ids.add(asEvidenceId(edge.from));
    }
  }
  return [...ids].sort();
}

export function reverseDependencyEdges(graph: EvidenceGraph): number {
  return graph.edges.filter(
    (edge) =>
      edge.relation === "REFERENCES" || edge.relation === "MAY_CALL" || edge.relation === "IMPORTS",
  ).length;
}
