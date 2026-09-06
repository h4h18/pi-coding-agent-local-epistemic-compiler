import type {
  ArtifactEnvelope,
  EvidenceRecord,
  JsonValue,
  ObjectDigest,
  VerdictReport,
} from "@pi-hec/contracts";
import { objectDigestFromBytes } from "@pi-hec/contracts";
import type { KeyObject } from "node:crypto";
import { ADMISSIBILITY_POLICY, policyRevisionDigest } from "./policy.js";
import { observationSignature } from "../producers/record.js";
import { verifyArtifactEnvelope } from "../plan/envelope.js";
import type { ArtifactStore } from "../producers/types.js";

export type EvidenceAssessment = VerdictReport["evidenceAssessments"][number];

export type AssessContext = {
  baselineSealObjectDigest: ObjectDigest;
  candidateManifestObjectDigest: ObjectDigest | undefined;
  environmentSealObjectDigest: ObjectDigest;
  producerIds: ReadonlySet<string>;
  mutatedEvidenceIds?: ReadonlySet<string>;
  artifacts?: ArtifactStore;
  evidenceEnvelopes?: ReadonlyMap<string, ArtifactEnvelope<JsonValue>>;
  envelopePublicKey?: KeyObject;
};

export function assessEvidence(record: EvidenceRecord, context: AssessContext): EvidenceAssessment {
  const policyRevisionObjectDigest = policyRevisionDigest();
  const reasons: string[] = [];
  for (const origin of ADMISSIBILITY_POLICY.forbiddenOrigins) {
    if (record.origin === origin) {
      reasons.push(`origin:${origin}`);
    }
  }
  if (
    ADMISSIBILITY_POLICY.requireBaselineSealMatch &&
    record.baselineSealObjectDigest !== context.baselineSealObjectDigest
  ) {
    reasons.push("baseline-seal-mismatch");
  }
  if (record.environmentSealObjectDigest !== context.environmentSealObjectDigest) {
    reasons.push("environment-incompatible");
  }
  if (ADMISSIBILITY_POLICY.requireProducerRegistry && !context.producerIds.has(record.producerId)) {
    reasons.push("producer-not-registered");
  }
  if (record.subject.kind === "CANDIDATE") {
    if (
      context.candidateManifestObjectDigest !== undefined &&
      record.subject.candidateManifestObjectDigest !== context.candidateManifestObjectDigest
    ) {
      reasons.push("candidate-binding-mismatch");
    }
  }
  if (!observationChainValid(record)) {
    reasons.push("signature-chain");
  }
  if (!envelopeChainValid(record, context)) {
    reasons.push("signature-chain");
  }
  if (!artifactIntegrityValid(record, context)) {
    reasons.push("artifact-integrity");
  }
  if (context.mutatedEvidenceIds?.has(record.id) === true) {
    reasons.push("artifact-integrity");
  }
  if (reasons.length > 0) {
    return {
      evidenceId: record.id,
      state: "INADMISSIBLE",
      policyRevisionObjectDigest,
      reasons,
    };
  }
  return {
    evidenceId: record.id,
    state: "ADMISSIBLE",
    policyRevisionObjectDigest,
  };
}

export function assessAll(
  records: readonly EvidenceRecord[],
  context: AssessContext,
): EvidenceAssessment[] {
  return records.map((record) => assessEvidence(record, context));
}

export function admissibleRecords(
  records: readonly EvidenceRecord[],
  assessments: readonly EvidenceAssessment[],
): EvidenceRecord[] {
  const allowed = new Set(
    assessments.filter((item) => item.state === "ADMISSIBLE").map((item) => item.evidenceId),
  );
  return records.filter((record) => allowed.has(record.id));
}

function observationChainValid(record: EvidenceRecord): boolean {
  for (const item of record.observations) {
    const expected = observationSignature(item);
    if (item.observationSignature !== expected.observationSignature) {
      return false;
    }
  }
  return true;
}

function envelopeChainValid(record: EvidenceRecord, context: AssessContext): boolean {
  const envelope = context.evidenceEnvelopes?.get(record.id);
  if (envelope === undefined) {
    return true;
  }
  if (context.envelopePublicKey === undefined) {
    return false;
  }
  return verifyArtifactEnvelope(envelope, context.envelopePublicKey);
}

function artifactIntegrityValid(record: EvidenceRecord, context: AssessContext): boolean {
  if (context.artifacts === undefined) {
    return true;
  }
  for (const digest of record.artifactObjectDigests) {
    const text = context.artifacts.getText(digest);
    if (text === undefined) {
      return false;
    }
    const computed = objectDigestFromBytes(Buffer.from(text, "utf8"));
    if (computed !== digest) {
      return false;
    }
  }
  return true;
}
