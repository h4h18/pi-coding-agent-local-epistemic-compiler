import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";
import { xmlElements } from "./xml.js";

const ID = "coverage";

export type CoverageSummary = {
  format: "lcov" | "cobertura";
  linesFound: number;
  linesHit: number;
};

export function parseLcov(text: string): CoverageSummary {
  let linesFound = 0;
  let linesHit = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("LF:")) {
      linesFound += Number.parseInt(line.slice(3), 10);
    } else if (line.startsWith("LH:")) {
      linesHit += Number.parseInt(line.slice(3), 10);
    } else if (line.startsWith("DA:")) {
      const parts = line.slice(3).split(",");
      const hits = Number.parseInt(parts[1] ?? "0", 10);
      linesFound += 1;
      if (hits > 0) {
        linesHit += 1;
      }
    }
  }
  return { format: "lcov", linesFound, linesHit };
}

export function parseCobertura(xml: string): CoverageSummary {
  const lines = xmlElements(xml, "line");
  let linesFound = 0;
  let linesHit = 0;
  for (const line of lines) {
    linesFound += 1;
    const hits = Number.parseInt(line.attrs.hits ?? "0", 10);
    if (hits > 0) {
      linesHit += 1;
    }
  }
  if (linesFound === 0) {
    const coverage = xmlElements(xml, "coverage")[0];
    const rate = coverage === undefined ? undefined : coverage.attrs["line-rate"];
    if (rate !== undefined) {
      const parsed = Number.parseFloat(rate);
      return { format: "cobertura", linesFound: 100, linesHit: Number.isFinite(parsed) ? Math.round(parsed * 100) : 0 };
    }
  }
  return { format: "cobertura", linesFound, linesHit };
}

export function createCoverageProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    async probe() {
      if (
        !hostHasPath(
          host,
          (path) => path.endsWith(".info") || path.endsWith("coverage.xml") || path.includes("lcov") || path.includes("cobertura"),
        )
      ) {
        return [];
      }
      return [capability(ID, ["lcov", "cobertura"])];
    },
    async plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "FUNCTIONAL") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "coverage-parse", versionObjectDigest, "CANDIDATE")];
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
      const last = lastObservation(observations);
      const text = last === undefined ? hostCoverage(host) : stdoutText(last, artifacts);
      const summary = summarizeCoverage(text);
      if (summary === undefined || summary.linesFound === 0) {
        return [];
      }
      const relation: EvidenceRecord["relation"] =
        summary.linesHit === 0 ? "REFUTES" : summary.linesHit < summary.linesFound ? "NEUTRAL" : "SUPPORTS";
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

function summarizeCoverage(text: string): CoverageSummary | undefined {
  if (text.includes("end_of_record") || text.includes("SF:")) {
    return parseLcov(text);
  }
  if (text.includes("<coverage") || text.includes("<line ")) {
    return parseCobertura(text);
  }
  return undefined;
}

function hostCoverage(host: ProducerHost): string {
  for (const path of host.listPaths()) {
    if (path.endsWith(".info") || path.endsWith("coverage.xml") || path.includes("lcov") || path.includes("cobertura")) {
      return host.readText(path) ?? "";
    }
  }
  return "";
}
