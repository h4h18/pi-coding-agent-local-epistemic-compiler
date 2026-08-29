import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, commandCheck, intrinsicCheck, isCommandRecipe } from "./helpers.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "generic-process";

export function createGenericProcessProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    async probe() {
      return [capability(ID, ["process-exit", "stdout", "stderr"])];
    },
    async plan(obligation: ProofObligation) {
      const checks: CheckNode[] = [];
      for (const spec of host.commands()) {
        checks.push(commandCheck([obligation.id], spec, "PAIRED"));
      }
      checks.push(intrinsicCheck([obligation.id], "generic-process-parse", versionObjectDigest, "CANDIDATE"));
      return checks;
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
      const last = lastObservation(observations);
      if (last === undefined) {
        return [];
      }
      const collected = collectedTestCount(stdoutText(last, artifacts));
      let relation: EvidenceRecord["relation"] = "NEUTRAL";
      if (last.exitCode !== undefined && last.exitCode !== 0) {
        relation = "REFUTES";
      } else if (last.exitCode === 0 && collected > 0 && last.state === "PASSED") {
        relation = "SUPPORTS";
      }
      return [
        evidenceFromParse({
          check,
          observations,
          relation,
          origin: isCommandRecipe(check.recipe) ? "SEALED_PROJECT" : "VERIFIER",
          oracle: "EXPLICIT_EXPECTATION",
          producerId: ID,
          producerVersionObjectDigest: versionObjectDigest,
          bindings,
        }),
      ];
    },
  };
}

export function collectedTestCount(stdout: string): number {
  const junit = /tests="(\d+)"/.exec(stdout);
  if (junit !== null && junit[1] !== undefined) {
    return Number.parseInt(junit[1], 10);
  }
  const tap = /^1\.\.(\d+)\s*$/m.exec(stdout);
  if (tap !== null && tap[1] !== undefined) {
    return Number.parseInt(tap[1], 10);
  }
  const words = /(\d+)\s+(?:tests?|specs?)\s+(?:run|collected|passed)/i.exec(stdout);
  if (words !== null && words[1] !== undefined) {
    return Number.parseInt(words[1], 10);
  }
  return 0;
}
