import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { relationFromKeySets, splitPairedBlocks } from "./compat.js";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "graphql";

export function graphqlKeys(sdl: string): Set<string> {
  const keys = new Set<string>();
  const typeRe = /(?:type|interface|enum|input|union|scalar)\s+([A-Za-z_][\w]*)/g;
  let match = typeRe.exec(sdl);
  while (match !== null) {
    if (match[1] !== undefined) {
      keys.add(`type:${match[1]}`);
    }
    match = typeRe.exec(sdl);
  }
  const fieldRe = /^\s{2}([A-Za-z_][\w]*)\s*(\(|:)/gm;
  let field = fieldRe.exec(sdl);
  while (field !== null) {
    if (field[1] !== undefined) {
      keys.add(`field:${field[1]}`);
    }
    field = fieldRe.exec(sdl);
  }
  return keys;
}

export function createGraphqlProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    async probe() {
      if (!hostHasPath(host, (path) => path.endsWith(".graphql") || path.endsWith(".gql") || path.includes("schema.graphql"))) {
        return [];
      }
      return [capability(ID, ["graphql-schema-diff"])];
    },
    async plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "SCHEMA_COMPATIBILITY" && obligation.kind !== "WIRE_COMPATIBILITY") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "graphql-diff", versionObjectDigest, "PAIRED")];
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
      const last = lastObservation(observations);
      const text = last === undefined ? hostText(host) : stdoutText(last, artifacts);
      const paired = splitPairedBlocks(text);
      if (paired === undefined) {
        return [];
      }
      const relation = relationFromKeySets(graphqlKeys(paired.baseline), graphqlKeys(paired.candidate));
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
    if (path.endsWith(".graphql") || path.endsWith(".gql")) {
      return host.readText(path) ?? "";
    }
  }
  return "";
}
