import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";
import { xmlElements } from "./xml.js";

const ID = "junit";

export type JunitCase = {
  name: string;
  classname: string;
  status: "passed" | "failed" | "error" | "skipped";
  assertions: number;
};

export function parseJunitXml(xml: string): JunitCase[] {
  const cases = xmlElements(xml, "testcase");
  return cases.map((item) => {
    const name = item.attrs.name ?? "unknown";
    const classname = item.attrs.classname ?? "";
    const assertions = Number.parseInt(item.attrs.assertions ?? "0", 10);
    let status: JunitCase["status"] = "passed";
    if (xmlElements(item.body, "skipped").length > 0) {
      status = "skipped";
    } else if (xmlElements(item.body, "failure").length > 0) {
      status = "failed";
    } else if (xmlElements(item.body, "error").length > 0) {
      status = "error";
    }
    return { name, classname, status, assertions: Number.isFinite(assertions) ? assertions : 0 };
  });
}

export function createJunitProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    async probe() {
      if (!hostHasPath(host, (path) => path.endsWith(".xml") || path.includes("junit"))) {
        return [];
      }
      return [capability(ID, ["junit-xml"])];
    },
    async plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "FUNCTIONAL" && obligation.kind !== "REPRODUCTION") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "junit-parse", versionObjectDigest, "CANDIDATE")];
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
      const last = lastObservation(observations);
      const xml = last === undefined ? hostJunit(host) : stdoutText(last, artifacts);
      if (!xml.includes("<testcase")) {
        return [];
      }
      const cases = parseJunitXml(xml);
      if (cases.length === 0) {
        return [];
      }
      const failed = cases.some((item) => item.status === "failed" || item.status === "error");
      const relation: EvidenceRecord["relation"] = failed ? "REFUTES" : "SUPPORTS";
      return [
        evidenceFromParse({
          check,
          observations,
          relation,
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

function hostJunit(host: ProducerHost): string {
  for (const path of host.listPaths()) {
    if (path.endsWith(".xml")) {
      const text = host.readText(path);
      if (text !== undefined && text.includes("<testcase")) {
        return text;
      }
    }
  }
  return "";
}
