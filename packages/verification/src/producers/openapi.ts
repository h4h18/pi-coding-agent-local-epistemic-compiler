import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { relationFromKeySets, splitPairedBlocks } from "./compat.js";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, parseJsonValue, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "openapi";

export function openApiKeys(text: string): Set<string> {
  const keys = new Set<string>();
  if (text.trimStart().startsWith("{")) {
    const parsed = parseJsonValue(text);
    if (parsed !== undefined) {
      collectOpenApi(parsed, keys);
    }
    return keys;
  }
  const pathBlock = /^  (\/\S+):$/gm;
  let match = pathBlock.exec(text);
  while (match !== null) {
    if (match[1] !== undefined) {
      keys.add(`path:${match[1]}`);
    }
    match = pathBlock.exec(text);
  }
  const method = /^\s{4}(get|put|post|delete|patch|options|head|trace):/gim;
  let methodMatch = method.exec(text);
  while (methodMatch !== null) {
    if (methodMatch[1] !== undefined) {
      keys.add(`method:${methodMatch[1].toLowerCase()}`);
    }
    methodMatch = method.exec(text);
  }
  return keys;
}

function collectOpenApi(value: unknown, keys: Set<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const record = objectRecord(value);
  const paths = record.paths;
  if (paths !== null && typeof paths === "object" && !Array.isArray(paths)) {
    for (const [path, ops] of Object.entries(objectRecord(paths))) {
      keys.add(`path:${path}`);
      if (ops !== null && typeof ops === "object" && !Array.isArray(ops)) {
        for (const method of Object.keys(objectRecord(ops))) {
          keys.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }
  }
  const components = record.components;
  if (components !== null && typeof components === "object" && !Array.isArray(components)) {
    const schemas = objectRecord(components).schemas;
    if (schemas !== null && typeof schemas === "object" && !Array.isArray(schemas)) {
      for (const name of Object.keys(objectRecord(schemas))) {
        keys.add(`schema:${name}`);
      }
    }
  }
}

function objectRecord(value: object): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}

export function createOpenApiProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    probe() {
      if (!hostHasPath(host, (path) => path.includes("openapi") || path.includes("swagger"))) {
        return [];
      }
      return [capability(ID, ["openapi-diff"])];
    },
    plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "WIRE_COMPATIBILITY" && obligation.kind !== "SCHEMA_COMPATIBILITY") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "openapi-diff", versionObjectDigest, "PAIRED")];
    },
    parse(check: CheckNode, observations: readonly RunObservation[]): readonly EvidenceRecord[] {
      const last = lastObservation(observations);
      const text = last === undefined ? hostText(host) : stdoutText(last, artifacts);
      const paired = splitPairedBlocks(text);
      if (paired === undefined) {
        return [];
      }
      const relation = relationFromKeySets(
        openApiKeys(paired.baseline),
        openApiKeys(paired.candidate),
      );
      if (relation === undefined) {
        return [];
      }
      return [
        evidenceFromParse({
          check,
          observations,
          relation,
          origin: "VERIFIER",
          oracle: "SCHEMA_DIFF",
          producerId: ID,
          producerVersionObjectDigest: versionObjectDigest,
          bindings,
        }),
      ];
    },
  };
}

function hostText(host: ProducerHost): string {
  for (const path of host.listPaths()) {
    if (path.includes("openapi") || path.includes("swagger")) {
      return host.readText(path) ?? "";
    }
  }
  return "";
}
