import type {
  EvidenceBundle,
  EvidenceGraph,
  EvidenceId,
  EvidenceNode,
  RequirementLedger,
} from "@pi-hec/contracts";
import { asEvidenceId, compareUtf8 } from "@pi-hec/evidence";

export type OmissionReason = "duplicate" | "lower-utility" | "untrusted" | "window-capacity";

export type OmittedEvidence = {
  evidenceId: EvidenceId;
  reason: OmissionReason;
};

export type BundleSelection =
  | {
      kind: "selected";
      bundles: readonly EvidenceBundle[];
      omitted: readonly OmittedEvidence[];
    }
  | { kind: "capacity"; omitted: readonly OmittedEvidence[] };

const KIND_RANK: Readonly<Record<string, number>> = {
  directory: 0,
  file: 1,
  symbol: 2,
  "code-region": 3,
  test: 4,
  "test-result": 5,
};

export function isNeverOmitBundle(bundle: EvidenceBundle, graph: EvidenceGraph): boolean {
  if (bundle.mandatory) {
    return true;
  }
  if (
    bundle.purpose === "requirement-witness" ||
    bundle.purpose === "instruction-scope" ||
    bundle.purpose === "verification-capability"
  ) {
    return true;
  }
  if (bundle.purpose === "counter-evidence") {
    return true;
  }
  const nodes = nodesOf(bundle, graph);
  if (nodes.some((node) => node.kind === "test-result" || node.kind === "test")) {
    const failing = graph.edges.some(
      (edge) =>
        bundle.edgeIds.includes(edge.id) &&
        (edge.relation === "FAILS_AT" || edge.relation === "CONTRADICTS"),
    );
    if (failing) {
      return true;
    }
  }
  return false;
}

function nodesOf(bundle: EvidenceBundle, graph: EvidenceGraph): EvidenceNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return bundle.nodeIds.flatMap((id) => {
    const node = byId.get(id);
    return node === undefined ? [] : [node];
  });
}

function requirementWeight(ledger: RequirementLedger, requirementId: string): number {
  const requirement = ledger.requirements.find((item) => item.id === requirementId);
  if (requirement === undefined) {
    return 0;
  }
  return requirement.priority === "MUST" ? 1 : 0.5;
}

function coveredRequirements(bundle: EvidenceBundle, graph: EvidenceGraph, ledger: RequirementLedger): string[] {
  const ids = new Set<string>();
  if (bundle.purpose === "requirement-witness") {
    for (const requirement of ledger.requirements) {
      const node = graph.nodes.find((item) => item.identityKey === `requirement:${requirement.id}`);
      if (node !== undefined && bundle.nodeIds.includes(node.id)) {
        ids.add(requirement.id);
      }
    }
  }
  for (const edge of graph.edges) {
    if (!bundle.edgeIds.includes(edge.id)) {
      continue;
    }
    if (edge.relation !== "SATISFIES" && edge.relation !== "COVERED_BY" && edge.relation !== "SUPPORTS") {
      continue;
    }
    for (const endpoint of [edge.from, edge.to]) {
      const node = graph.nodes.find((item) => item.id === endpoint);
      if (node?.kind === "requirement") {
        const requirementId = node.identityKey.replace(/^requirement:/u, "");
        ids.add(requirementId);
      }
    }
  }
  return [...ids];
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function nodeKeys(bundle: EvidenceBundle, graph: EvidenceGraph): Set<string> {
  return new Set(nodesOf(bundle, graph).map((node) => node.identityKey));
}

function contentDigests(bundle: EvidenceBundle, graph: EvidenceGraph): Set<string> {
  const digests = new Set<string>();
  for (const node of nodesOf(bundle, graph)) {
    if (node.contentObjectDigest !== undefined) {
      digests.add(node.contentObjectDigest);
    }
  }
  return digests;
}

function independenceGroups(bundle: EvidenceBundle, graph: EvidenceGraph): Set<string> {
  return new Set(nodesOf(bundle, graph).map((node) => node.trust.independenceGroup));
}

function adversarialRisk(bundle: EvidenceBundle, graph: EvidenceGraph): number {
  const nodes = nodesOf(bundle, graph);
  if (nodes.length === 0) {
    return 0;
  }
  return nodes.reduce((sum, node) => sum + node.trust.adversarialRisk, 0) / nodes.length;
}

function isUntrusted(bundle: EvidenceBundle, graph: EvidenceGraph): boolean {
  return nodesOf(bundle, graph).some(
    (node) =>
      node.trust.adversarialRisk >= 0.85 ||
      node.status === "invalidated" ||
      node.authorship === "LOCAL_MODEL",
  );
}

function isDuplicateOf(
  candidate: EvidenceBundle,
  selected: readonly EvidenceBundle[],
  graph: EvidenceGraph,
): boolean {
  const keys = nodeKeys(candidate, graph);
  const digests = contentDigests(candidate, graph);
  for (const bundle of selected) {
    const overlap = jaccard(keys, nodeKeys(bundle, graph));
    if (overlap >= 0.9) {
      return true;
    }
    const existing = contentDigests(bundle, graph);
    for (const digest of digests) {
      if (existing.has(digest) && digests.size > 0 && existing.size > 0) {
        return true;
      }
    }
  }
  return false;
}

export function utilityOf(
  selected: readonly EvidenceBundle[],
  candidate: EvidenceBundle | undefined,
  graph: EvidenceGraph,
  ledger: RequirementLedger,
  tokenCost: number,
): number {
  const set = candidate === undefined ? selected : [...selected, candidate];
  let coverage = 0;
  for (const requirement of ledger.requirements) {
    let hits = 0;
    for (const bundle of set) {
      if (coveredRequirements(bundle, graph, ledger).includes(requirement.id)) {
        hits += 1;
      }
    }
    coverage += requirementWeight(ledger, requirement.id) * Math.min(1, hits);
  }
  let causal = 0;
  let witnesses = 0;
  const groups = new Set<string>();
  let overlap = 0;
  let risk = 0;
  const seenKeys: Set<string>[] = [];
  for (const bundle of set) {
    if (bundle.purpose === "causal-path") {
      causal += 2;
    }
    if (bundle.purpose === "requirement-witness" || bundle.purpose === "counter-evidence") {
      witnesses += 1;
    }
    for (const group of independenceGroups(bundle, graph)) {
      groups.add(group);
    }
    const keys = nodeKeys(bundle, graph);
    for (const prior of seenKeys) {
      overlap += jaccard(keys, prior);
    }
    seenKeys.push(keys);
    risk += adversarialRisk(bundle, graph);
  }
  return coverage + causal + witnesses + groups.size * 0.25 - overlap - risk - tokenCost / 1000;
}

export function hierarchySortKey(node: EvidenceNode): string {
  const rank = KIND_RANK[node.kind] ?? 50;
  return `${String(rank).padStart(2, "0")}\u0000${node.identityKey}\u0000${node.label}`;
}

function omitNodes(
  bundle: EvidenceBundle,
  reason: OmissionReason,
  selectedIds: ReadonlySet<string>,
  into: OmittedEvidence[],
): void {
  for (const id of bundle.nodeIds) {
    if (selectedIds.has(id)) {
      continue;
    }
    into.push({ evidenceId: asEvidenceId(id), reason });
  }
}

export function selectBundles(input: {
  bundles: readonly EvidenceBundle[];
  graph: EvidenceGraph;
  ledger: RequirementLedger;
  tokenBudget: number;
  estimateBundleTokens: (bundle: EvidenceBundle) => number;
}): BundleSelection {
  const ordered = [...input.bundles].sort((left, right) => compareUtf8(left.id, right.id));
  const mandatory = ordered.filter((bundle) => isNeverOmitBundle(bundle, input.graph));
  const optional = ordered.filter((bundle) => !isNeverOmitBundle(bundle, input.graph));
  const selected: EvidenceBundle[] = [];
  const omitted: OmittedEvidence[] = [];
  const selectedIds = new Set<string>();
  let used = 0;
  for (const bundle of mandatory) {
    if (isUntrusted(bundle, input.graph)) {
      omitNodes(bundle, "untrusted", selectedIds, omitted);
      continue;
    }
    const cost = input.estimateBundleTokens(bundle);
    if (used + cost > input.tokenBudget) {
      return { kind: "capacity", omitted };
    }
    selected.push(bundle);
    used += cost;
    for (const id of bundle.nodeIds) {
      selectedIds.add(id);
    }
  }
  const remaining = [...optional];
  while (remaining.length > 0) {
    const baseline = utilityOf(selected, undefined, input.graph, input.ledger, 0);
    let bestIndex = -1;
    let bestGain = 0;
    let bestId = "";
    for (let index = 0; index < remaining.length; index += 1) {
      const bundle = remaining[index];
      if (bundle === undefined) {
        continue;
      }
      const cost = Math.max(1, input.estimateBundleTokens(bundle));
      const next = utilityOf(selected, bundle, input.graph, input.ledger, cost);
      const gain = (next - baseline) / cost;
      if (gain > bestGain || (gain === bestGain && compareUtf8(bundle.id, bestId) < 0 && gain > 0)) {
        bestGain = gain;
        bestIndex = index;
        bestId = bundle.id;
      }
    }
    if (bestIndex < 0 || bestGain <= 0) {
      for (const bundle of remaining) {
        omitNodes(bundle, "lower-utility", selectedIds, omitted);
      }
      break;
    }
    const chosen = remaining.splice(bestIndex, 1)[0];
    if (chosen === undefined) {
      break;
    }
    if (isUntrusted(chosen, input.graph)) {
      omitNodes(chosen, "untrusted", selectedIds, omitted);
      continue;
    }
    if (isDuplicateOf(chosen, selected, input.graph)) {
      omitNodes(chosen, "duplicate", selectedIds, omitted);
      continue;
    }
    const cost = input.estimateBundleTokens(chosen);
    if (used + cost > input.tokenBudget) {
      omitNodes(chosen, "window-capacity", selectedIds, omitted);
      continue;
    }
    selected.push(chosen);
    used += cost;
    for (const id of chosen.nodeIds) {
      selectedIds.add(id);
    }
  }
  const uniqueOmitted: OmittedEvidence[] = [];
  const seen = new Set<string>();
  for (const item of omitted.sort((left, right) => compareUtf8(left.evidenceId, right.evidenceId))) {
    if (selectedIds.has(item.evidenceId)) {
      continue;
    }
    const key = `${item.evidenceId}:${item.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueOmitted.push(item);
  }
  return { kind: "selected", bundles: selected, omitted: uniqueOmitted };
}
