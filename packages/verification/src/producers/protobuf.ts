import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { relationFromKeySets, splitPairedBlocks } from "./compat.js";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "protobuf";

export function protobufKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const msg = /message\s+([A-Za-z_][\w]*)/g;
  let match = msg.exec(text);
  while (match !== null) {
    if (match[1] !== undefined) {
      keys.add(`message:${match[1]}`);
    }
    match = msg.exec(text);
  }
  const field = /^\s*(optional|required|repeated)?\s*[\w.]+\s+([A-Za-z_][\w]*)\s*=\s*(\d+)/gm;
  let fieldMatch = field.exec(text);
  while (fieldMatch !== null) {
    if (fieldMatch[2] !== undefined && fieldMatch[3] !== undefined) {
      keys.add(`field:${fieldMatch[3]}:${fieldMatch[2]}`);
    }
    fieldMatch = field.exec(text);
  }
  return keys;
}

export function createProtobufProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    async probe() {
      if (!hostHasPath(host, (path) => path.endsWith(".proto"))) {
        return [];
      }
      return [capability(ID, ["protobuf-compatibility"])];
    },
    async plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "WIRE_COMPATIBILITY" && obligation.kind !== "SCHEMA_COMPATIBILITY") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "protobuf-diff", versionObjectDigest, "PAIRED")];
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
      const last = lastObservation(observations);
      const text = last === undefined ? hostText(host) : stdoutText(last, artifacts);
      const paired = splitPairedBlocks(text);
      if (paired === undefined) {
        return [];
      }
      const relation = relationFromKeySets(protobufKeys(paired.baseline), protobufKeys(paired.candidate));
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
    if (path.endsWith(".proto")) {
      return host.readText(path) ?? "";
    }
  }
  return "";
}
