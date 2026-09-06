import type { CheckNode, EvidenceRecord, ObjectDigest, RunObservation } from "@pi-hec/contracts";
import { makeEvidenceRecord, obligationIdsOf } from "./record.js";
import type { ArtifactStore, ProducerBindings } from "./types.js";
import { subjectFor } from "./types.js";

export function stdoutText(observation: RunObservation, artifacts: ArtifactStore): string {
  if (observation.stdoutArtifact === undefined) {
    return "";
  }
  return artifacts.getText(observation.stdoutArtifact) ?? "";
}

export function stderrText(observation: RunObservation, artifacts: ArtifactStore): string {
  if (observation.stderrArtifact === undefined) {
    return "";
  }
  return artifacts.getText(observation.stderrArtifact) ?? "";
}

export function observationArtifacts(observation: RunObservation): string[] {
  const out: string[] = [];
  if (observation.stdoutArtifact !== undefined) {
    out.push(observation.stdoutArtifact);
  }
  if (observation.stderrArtifact !== undefined) {
    out.push(observation.stderrArtifact);
  }
  return out;
}

export function lastObservation(observations: readonly RunObservation[]): RunObservation | undefined {
  return observations[observations.length - 1];
}

export function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function evidenceFromParse(input: {
  check: CheckNode;
  observations: readonly RunObservation[];
  relation: EvidenceRecord["relation"];
  origin: EvidenceRecord["origin"];
  oracle: EvidenceRecord["oracle"];
  producerId: string;
  producerVersionObjectDigest: ObjectDigest;
  bindings: ProducerBindings;
  extraArtifacts?: readonly string[];
  salt?: string;
}): EvidenceRecord {
  const last = lastObservation(input.observations);
  const artifacts = [...(last === undefined ? [] : observationArtifacts(last)), ...(input.extraArtifacts ?? [])];
  return makeEvidenceRecord({
    obligationId: obligationIdsOf(input.check),
    relation: input.relation,
    origin: input.origin,
    independenceGroup: input.producerId,
    oracle: input.oracle,
    baselineSealObjectDigest: input.bindings.baselineSealObjectDigest,
    subject: subjectFor(input.check, input.bindings),
    producerId: input.producerId,
    producerVersionObjectDigest: input.producerVersionObjectDigest,
    environmentSealObjectDigest: input.bindings.environmentSealObjectDigest,
    observations: input.observations,
    artifactObjectDigests: artifacts,
    ...(input.salt === undefined ? {} : { salt: input.salt }),
  });
}
