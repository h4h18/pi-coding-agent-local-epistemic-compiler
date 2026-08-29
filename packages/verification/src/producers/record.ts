import {
  taggedHash,
  type CheckNode,
  type EvidenceRecord,
  type ObjectDigest,
  type RunObservation,
} from "@pi-hec/contracts";
import { mintGeneralId } from "../plan/ids.js";

export type EvidenceDraft = {
  obligationId: EvidenceRecord["obligationId"];
  relation: EvidenceRecord["relation"];
  origin: EvidenceRecord["origin"];
  independenceGroup: string;
  oracle: EvidenceRecord["oracle"];
  baselineSealObjectDigest: ObjectDigest;
  subject: EvidenceRecord["subject"];
  producerId: string;
  producerVersionObjectDigest: ObjectDigest;
  environmentSealObjectDigest: ObjectDigest;
  observations: readonly RunObservation[];
  artifactObjectDigests: readonly EvidenceRecord["artifactObjectDigests"][number][];
  salt?: string;
};

export function observationSignature(observation: RunObservation): RunObservation {
  const payload: {
    attempt: number;
    state: RunObservation["state"];
    exitCode?: number;
    stdoutDigest?: string;
    stderrDigest?: string;
  } = {
    attempt: observation.attempt,
    state: observation.state,
  };
  if (observation.exitCode !== undefined) {
    payload.exitCode = observation.exitCode;
  }
  if (observation.stdoutArtifact !== undefined) {
    payload.stdoutDigest = observation.stdoutArtifact;
  }
  if (observation.stderrArtifact !== undefined) {
    payload.stderrDigest = observation.stderrArtifact;
  }
  const signature = taggedHash("observation-signature", 1, payload);
  return { ...observation, observationSignature: signature };
}

export function makeEvidenceRecord(draft: EvidenceDraft): EvidenceRecord {
  const signed = draft.observations.map(observationSignature);
  return {
    schemaVersion: 1,
    id: mintGeneralId(
      "ev",
      `${draft.producerId}:${draft.obligationId}:${draft.relation}:${draft.origin}:${draft.salt ?? ""}`,
    ),
    obligationId: draft.obligationId,
    relation: draft.relation,
    origin: draft.origin,
    independenceGroup: draft.independenceGroup,
    oracle: draft.oracle,
    baselineSealObjectDigest: draft.baselineSealObjectDigest,
    subject: draft.subject,
    producerId: draft.producerId,
    producerVersionObjectDigest: draft.producerVersionObjectDigest,
    environmentSealObjectDigest: draft.environmentSealObjectDigest,
    observations: signed,
    artifactObjectDigests: [...draft.artifactObjectDigests],
  };
}

export function obligationIdsOf(check: Pick<CheckNode, "obligationIds">): EvidenceRecord["obligationId"] {
  const first = check.obligationIds[0];
  if (first === undefined) {
    throw new Error("check is missing obligationIds");
  }
  return first;
}
