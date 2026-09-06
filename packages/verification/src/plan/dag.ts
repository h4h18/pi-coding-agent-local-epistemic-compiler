import type { CheckNode, ProofObligation, VerificationPlan } from "@pi-hec/contracts";
import { PlanError } from "./errors.js";

export function assertAcyclicPlan(plan: Pick<VerificationPlan, "obligations" | "checks">): void {
  const obligationIds = new Set(plan.obligations.map((item) => item.id));
  const checkIds = new Set(plan.checks.map((item) => item.id));
  for (const obligation of plan.obligations) {
    for (const pre of obligation.prerequisites) {
      if (!obligationIds.has(pre)) {
        throw new PlanError(
          "MISSING_ID",
          `obligation ${obligation.id} prerequisite ${pre} does not exist`,
        );
      }
    }
  }
  for (const check of plan.checks) {
    for (const obligationId of check.obligationIds) {
      if (!obligationIds.has(obligationId)) {
        throw new PlanError(
          "MISSING_ID",
          `check ${check.id} obligation ${obligationId} does not exist`,
        );
      }
    }
    for (const dep of check.dependencies) {
      if (!checkIds.has(dep)) {
        throw new PlanError("MISSING_ID", `check ${check.id} dependency ${dep} does not exist`);
      }
    }
  }
  assertNoCycle(
    plan.obligations.map((item) => [item.id, item.prerequisites] as const),
    "obligation",
  );
  assertNoCycle(
    plan.checks.map((item) => [item.id, item.dependencies] as const),
    "check",
  );
}

function assertNoCycle(
  nodes: readonly (readonly [string, readonly string[]])[],
  label: string,
): void {
  const incoming = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const [id, deps] of nodes) {
    incoming.set(id, incoming.get(id) ?? 0);
    const list = edges.get(id) ?? [];
    edges.set(id, list);
    for (const dep of deps) {
      incoming.set(dep, incoming.get(dep) ?? 0);
      incoming.set(id, (incoming.get(id) ?? 0) + 1);
      const from = edges.get(dep) ?? [];
      from.push(id);
      edges.set(dep, from);
    }
  }
  const ready: string[] = [];
  for (const [id, count] of incoming) {
    if (count === 0) {
      ready.push(id);
    }
  }
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop();
    if (id === undefined) {
      break;
    }
    visited += 1;
    for (const next of edges.get(id) ?? []) {
      const nextCount = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, nextCount);
      if (nextCount === 0) {
        ready.push(next);
      }
    }
  }
  if (visited !== nodes.length) {
    throw new PlanError("CYCLE", `${label} graph contains a cycle`);
  }
}

export function topologicalChecks(checks: readonly CheckNode[]): CheckNode[] {
  const byId = new Map<string, CheckNode>();
  const incoming = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const check of checks) {
    byId.set(check.id, check);
    incoming.set(check.id, incoming.get(check.id) ?? 0);
    edges.set(check.id, edges.get(check.id) ?? []);
    for (const dep of check.dependencies) {
      incoming.set(check.id, (incoming.get(check.id) ?? 0) + 1);
      const list = edges.get(dep) ?? [];
      list.push(check.id);
      edges.set(dep, list);
    }
  }
  const ready = checks.filter((item) => (incoming.get(item.id) ?? 0) === 0).map((item) => item.id);
  const ordered: CheckNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) {
      break;
    }
    const node = byId.get(id);
    if (node !== undefined) {
      ordered.push(node);
    }
    for (const next of edges.get(id) ?? []) {
      const nextCount = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, nextCount);
      if (nextCount === 0) {
        ready.push(next);
      }
    }
  }
  return ordered;
}

export function topologicalObligations(obligations: readonly ProofObligation[]): ProofObligation[] {
  const byId = new Map<string, ProofObligation>();
  const incoming = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const obligation of obligations) {
    byId.set(obligation.id, obligation);
    incoming.set(obligation.id, incoming.get(obligation.id) ?? 0);
    edges.set(obligation.id, edges.get(obligation.id) ?? []);
    for (const pre of obligation.prerequisites) {
      incoming.set(obligation.id, (incoming.get(obligation.id) ?? 0) + 1);
      const list = edges.get(pre) ?? [];
      list.push(obligation.id);
      edges.set(pre, list);
    }
  }
  const ready = obligations
    .filter((item) => (incoming.get(item.id) ?? 0) === 0)
    .map((item) => item.id);
  const ordered: ProofObligation[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) {
      break;
    }
    const node = byId.get(id);
    if (node !== undefined) {
      ordered.push(node);
    }
    for (const next of edges.get(id) ?? []) {
      const nextCount = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, nextCount);
      if (nextCount === 0) {
        ready.push(next);
      }
    }
  }
  return ordered;
}
