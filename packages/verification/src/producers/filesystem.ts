import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "filesystem";

export function createFilesystemProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    async probe() {
      if (host.listPaths().length === 0) {
        return [];
      }
      return [capability(ID, ["filesystem-diff", "integrity"])];
    },
    async plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "EVIDENCE_INTEGRITY" && obligation.kind !== "FUNCTIONAL") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "filesystem-integrity", versionObjectDigest, "PAIRED")];
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
      const last = lastObservation(observations);
      const body = last === undefined ? snapshotListing(host) : stdoutText(last, artifacts);
      if (!body.includes("\t")) {
        return [];
      }
      const relation = listingHasMismatch(body) ? "REFUTES" : "SUPPORTS";
      return [
        evidenceFromParse({
          check,
          observations: observations.length > 0 ? observations : [],
          relation,
          origin: "VERIFIER",
          oracle: "DIFFERENTIAL",
          producerId: ID,
          producerVersionObjectDigest: versionObjectDigest,
          bindings,
        }),
      ];
    },
  };
}

function snapshotListing(host: ProducerHost): string {
  if (hostHasPath(host, (path) => path === "integrity.tsv")) {
    return host.readText("integrity.tsv") ?? "";
  }
  return "";
}

export function listingHasMismatch(body: string): boolean {
  for (const line of body.split(/\r?\n/)) {
    if (line.includes("\tMISMATCH") || line.endsWith("\tchanged")) {
      return true;
    }
    const parts = line.split("\t");
    if (parts.length >= 3 && parts[1] !== parts[2] && parts[1] !== undefined && parts[2] !== undefined) {
      return true;
    }
  }
  return false;
}
