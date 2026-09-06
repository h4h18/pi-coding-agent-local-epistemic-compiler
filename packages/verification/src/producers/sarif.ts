import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import {
  evidenceFromParse,
  isJsonObject,
  isUnknownArray,
  lastObservation,
  parseJsonValue,
  stdoutText,
} from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "sarif";

export type SarifFinding = {
  ruleId: string;
  level: string;
  kind: string;
};

export function parseSarif(text: string): SarifFinding[] {
  const parsed = parseJsonValue(text);
  if (!isJsonObject(parsed)) {
    return [];
  }
  const runs = parsed.runs;
  if (!isUnknownArray(runs)) {
    return [];
  }
  const findings: SarifFinding[] = [];
  for (const run of runs) {
    if (!isJsonObject(run)) {
      continue;
    }
    const results = run.results;
    if (!isUnknownArray(results)) {
      continue;
    }
    for (const result of results) {
      if (!isJsonObject(result)) {
        continue;
      }
      const ruleId = result.ruleId;
      const level = result.level;
      const kind = result.kind;
      findings.push({
        ruleId: typeof ruleId === "string" ? ruleId : "unknown",
        level: typeof level === "string" ? level : "warning",
        kind: typeof kind === "string" ? kind : "fail",
      });
    }
  }
  return findings;
}

export function createSarifProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    probe() {
      if (!hostHasPath(host, (path) => path.endsWith(".sarif"))) {
        return [];
      }
      return [capability(ID, ["sarif"])];
    },
    plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "STATIC_ANALYSIS" && obligation.kind !== "SECURITY") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "sarif-parse", versionObjectDigest, "CANDIDATE")];
    },
    parse(check: CheckNode, observations: readonly RunObservation[]): readonly EvidenceRecord[] {
      const last = lastObservation(observations);
      const text = last === undefined ? hostSarif(host) : stdoutText(last, artifacts);
      const findings = parseSarif(text);
      if (findings.length === 0) {
        return [];
      }
      const failed = findings.some((item) => item.kind === "fail" && item.level === "error");
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

function hostSarif(host: ProducerHost): string {
  for (const path of host.listPaths()) {
    if (path.endsWith(".sarif")) {
      return host.readText(path) ?? "";
    }
  }
  return "";
}
