import { createHash } from "node:crypto";
import { taggedHash, type EvidenceId, type JsonValue } from "@pi-hec/contracts";
import { sha256HexToCrockford32 } from "../ingestion/evidence-id.js";
import type { GraphEdgeRecord, IndexUnit } from "../ingestion/types.js";

export type GraphUnit = Pick<IndexUnit, "evidenceId" | "path" | "kind" | "imports" | "producer">;

function edgeId(from: EvidenceId, to: EvidenceId, relation: string, producer: string): string {
  const digest = taggedHash("evidence-edge", 1, {
    from,
    to,
    relation,
    polarity: "positive",
    provenanceIdentities: [producer],
  } satisfies JsonValue);
  return `edge_${sha256HexToCrockford32(digest.slice("sha256:".length))}`;
}

export { edgeId };

export function graphFromUnits(units: readonly GraphUnit[]): GraphEdgeRecord[] {
  const edges: GraphEdgeRecord[] = [];
  const byPath = new Map<string, GraphUnit[]>();
  for (const unit of units) {
    const list = byPath.get(unit.path) ?? [];
    list.push(unit);
    byPath.set(unit.path, list);
  }
  for (const group of byPath.values()) {
    const fileUnit = group.find((unit) => unit.kind === "file");
    if (fileUnit === undefined) {
      continue;
    }
    for (const child of group) {
      if (child.evidenceId === fileUnit.evidenceId) {
        continue;
      }
      edges.push({
        fromId: fileUnit.evidenceId,
        toId: child.evidenceId,
        relation: child.kind === "class" || child.kind === "function" ? "DEFINES" : "CONTAINS",
        producer: child.producer,
      });
    }
    for (const spec of fileUnit.imports) {
      const targetPath = resolveRelative(fileUnit.path, spec, byPath);
      if (targetPath === undefined) {
        continue;
      }
      const target = byPath.get(targetPath)?.find((unit) => unit.kind === "file");
      if (target === undefined) {
        continue;
      }
      edges.push({
        fromId: fileUnit.evidenceId,
        toId: target.evidenceId,
        relation: "IMPORTS",
        producer: fileUnit.producer,
      });
    }
  }
  return edges;
}

function resolveRelative(
  fromPath: string,
  spec: string,
  known: ReadonlyMap<string, GraphUnit[]>,
): string | undefined {
  if (!(spec.startsWith("./") || spec.startsWith("../"))) {
    return undefined;
  }
  const parts = fromPath.split("/");
  parts.pop();
  for (const segment of spec.split("/")) {
    if (segment === "." || segment === "") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join("/");
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".json", "/index.ts", "/index.js"];
  for (const ext of extensions) {
    const candidate = `${joined}${ext}`;
    if (known.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function stableEdgeKey(edge: GraphEdgeRecord): string {
  return createHash("sha256")
    .update(`${edge.fromId}|${edge.toId}|${edge.relation}|${edge.producer}`, "utf8")
    .digest("hex");
}
