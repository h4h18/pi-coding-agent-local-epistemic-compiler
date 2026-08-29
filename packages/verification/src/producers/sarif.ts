import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, parseJsonValue, stdoutText } from "./parse-support.js";
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
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const runs = objectField(parsed, "runs");
  if (!Array.isArray(runs)) {
    return [];
  }
  const findings: SarifFinding[] = [];
  for (const run of runs) {
    if (run === null || typeof run !== "object" || Array.isArray(run)) {
      continue;
    }
    const results = objectField(run, "results");
    if (!Array.isArray(results)) {
      continue;
    }
    for (const result of results) {
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        continue;
      }
      const ruleId = objectField(result, "ruleId");
      const level = objectField(result, "level");
      const kind = objectField(result, "kind");
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
    async probe() {
      if (!hostHasPath(host, (path) => path.endsWith(".sarif"))) {
        return [];
      }
      return [capability(ID, ["sarif"])];
    },
    async plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "STATIC_ANALYSIS" && obligation.kind !== "SECURITY") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "sarif-parse", versionObjectDigest, "CANDIDATE")];
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
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

function objectField(value: object, key: string): unknown {
  if (!(key in value)) {
    return undefined;
  }
  return Reflect.get(value, key);
}

function hostSarif(host: ProducerHost): string {
  for (const path of host.listPaths()) {
    if (path.endsWith(".sarif")) {
      return host.readText(path) ?? "";
    }
  }
  return "";
}
