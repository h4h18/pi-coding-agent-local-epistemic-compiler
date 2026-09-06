import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";
import { xmlElements } from "./xml.js";

const ID = "xctest";

export type XcTestCase = {
  identifier: string;
  status: "passed" | "failed" | "skipped";
};

export function parseXcResult(text: string): XcTestCase[] {
  if (text.includes("<testcase")) {
    return xmlElements(text, "testcase").map((item) => {
      let status: XcTestCase["status"] = "passed";
      if (xmlElements(item.body, "skipped").length > 0) {
        status = "skipped";
      } else if (
        xmlElements(item.body, "failure").length > 0 ||
        xmlElements(item.body, "error").length > 0
      ) {
        status = "failed";
      }
      return { identifier: item.attrs.name ?? "unknown", status };
    });
  }
  const cases: XcTestCase[] = [];
  const ident = /Test Case\s+'-\[([^\]]+)\]'\s+(passed|failed|skipped)/gi;
  let match = ident.exec(text);
  while (match !== null) {
    const name = match[1];
    const statusRaw = match[2];
    if (name !== undefined && statusRaw !== undefined) {
      const lowered = statusRaw.toLowerCase();
      cases.push({
        identifier: name,
        status: lowered === "failed" ? "failed" : lowered === "skipped" ? "skipped" : "passed",
      });
    }
    match = ident.exec(text);
  }
  return cases;
}

export function createXcTestProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    probe() {
      if (!hostHasPath(host, (path) => path.endsWith(".xcresult") || path.includes("xctest"))) {
        return [];
      }
      return [capability(ID, ["xctest-xcresult"])];
    },
    plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "MOBILE_LIFECYCLE" && obligation.kind !== "PLATFORM_MATRIX") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "xctest-parse", versionObjectDigest, "CANDIDATE")];
    },
    parse(check: CheckNode, observations: readonly RunObservation[]): readonly EvidenceRecord[] {
      const last = lastObservation(observations);
      if (last === undefined) {
        return [];
      }
      const cases = parseXcResult(stdoutText(last, artifacts));
      if (cases.length === 0) {
        return [];
      }
      const failed = cases.some((item) => item.status === "failed");
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
