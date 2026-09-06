import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { relationFromKeySets, splitPairedBlocks } from "./compat.js";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "abi";

export function abiSymbols(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const nm = /^\s*[0-9a-fA-F]*\s+[A-TV-Z]\s+(\S+)$/.exec(line.trim());
    if (nm !== null && nm[1] !== undefined) {
      keys.add(nm[1]);
      continue;
    }
    const dumpbin = /^\s+[0-9A-F]+\s+\w+\s+\w+\s+(\S+)$/.exec(line);
    if (dumpbin !== null && dumpbin[1] !== undefined) {
      keys.add(dumpbin[1]);
    }
  }
  return keys;
}

export function createAbiProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    probe() {
      if (!hostHasPath(host, (path) => path.endsWith(".so") || path.endsWith(".dll") || path.endsWith(".h") || path.includes("abi"))) {
        return [];
      }
      return [capability(ID, ["native-abi-diff"])];
    },
    plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "ABI_COMPATIBILITY") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "abi-diff", versionObjectDigest, "PAIRED")];
    },
    parse(check: CheckNode, observations: readonly RunObservation[]): readonly EvidenceRecord[] {
      const last = lastObservation(observations);
      const text = last === undefined ? hostText(host) : stdoutText(last, artifacts);
      const paired = splitPairedBlocks(text);
      if (paired === undefined) {
        return [];
      }
      const relation = relationFromKeySets(abiSymbols(paired.baseline), abiSymbols(paired.candidate));
      if (relation === undefined) {
        return [];
      }
      return [
        evidenceFromParse({
          check,
          observations,
          relation,
          origin: "VERIFIER",
          oracle: "ABI_DIFF",
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
    if (path.includes("abi") && path.endsWith(".txt")) {
      return host.readText(path) ?? "";
    }
  }
  return "";
}
