import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { parseJunitXml } from "./junit.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "android";

export function createAndroidProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    async probe() {
      if (!hostHasPath(host, (path) => path.includes("androidTest") || path.includes("instrumentation"))) {
        return [];
      }
      return [capability(ID, ["android-instrumentation"])];
    },
    async plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "MOBILE_LIFECYCLE" && obligation.kind !== "PLATFORM_MATRIX") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "android-instrumentation-parse", versionObjectDigest, "CANDIDATE")];
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
      const last = lastObservation(observations);
      if (last === undefined) {
        return [];
      }
      const xml = stdoutText(last, artifacts);
      if (!xml.includes("<testcase")) {
        return [];
      }
      const cases = parseJunitXml(xml);
      const failed = cases.some((item) => item.status === "failed" || item.status === "error");
      return [
        evidenceFromParse({
          check,
          observations,
          relation: failed ? "REFUTES" : "SUPPORTS",
          origin: "INDEPENDENT_TOOL",
          oracle: "EXPLICIT_EXPECTATION",
          producerId: ID,
          producerVersionObjectDigest: versionObjectDigest,
          bindings,
        }),
      ];
    },
  };
}
