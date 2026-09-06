import { type Static } from "typebox";
import { Compile } from "typebox/compile";
import {
  LocalSemanticFindingSchema,
  SemanticVerificationResultSchema,
  type CheckNode,
  type EvidenceRecord,
  type ProofObligation,
  type RunObservation,
} from "@pi-hec/contracts";
import { capability, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, parseJsonValue, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

type LocalSemanticFinding = Static<typeof LocalSemanticFindingSchema>;
type SemanticVerificationResult = Static<typeof SemanticVerificationResultSchema>;

const ID = "local-semantic";
const FINDING = Compile(LocalSemanticFindingSchema);
const RESULT = Compile(SemanticVerificationResultSchema);

function isFinding(value: unknown): value is LocalSemanticFinding {
  return FINDING.Check(value);
}

function isSemanticResult(value: unknown): value is SemanticVerificationResult {
  return RESULT.Check(value);
}

export function findingsFromTask12(text: string): readonly LocalSemanticFinding[] {
  const parsed = parseJsonValue(text);
  if (parsed === undefined) {
    return [];
  }
  if (isSemanticResult(parsed)) {
    return parsed.findings;
  }
  if (Array.isArray(parsed)) {
    return parsed.filter(isFinding);
  }
  if (isFinding(parsed)) {
    return [parsed];
  }
  return [];
}

export function createLocalSemanticProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    probe() {
      void host.listPaths();
      return [capability(ID, ["local-semantic-findings"])];
    },
    plan(obligation: ProofObligation) {
      return [
        intrinsicCheck([obligation.id], "local-semantic-ingest", versionObjectDigest, "CANDIDATE"),
      ];
    },
    parse(check: CheckNode, observations: readonly RunObservation[]): readonly EvidenceRecord[] {
      const last = lastObservation(observations);
      if (last === undefined) {
        return [];
      }
      const text = stdoutText(last, artifacts);
      if (text.length === 0) {
        return [];
      }
      const findings = findingsFromTask12(text);
      if (findings.length === 0) {
        return [];
      }
      return findings.map((finding) =>
        evidenceFromParse({
          check,
          observations,
          relation: "NEUTRAL",
          origin: "LOCAL_MODEL",
          oracle: "EXPLICIT_EXPECTATION",
          producerId: ID,
          producerVersionObjectDigest: versionObjectDigest,
          bindings,
          salt: finding.id,
        }),
      );
    },
  };
}
