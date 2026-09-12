import { type KeyObject } from "node:crypto";
import { Compile } from "typebox/compile";
import {
  VerificationPlanSchema,
  VerdictReportSchema,
  type ArtifactEnvelope,
  type EvidenceRecord,
  type JsonValue,
  type ObjectDigest,
  type RunObservation,
  type VerificationPlan,
  type VerdictReport,
} from "@pi-hec/contracts";
import {
  envelopeDigest,
  memoryHost,
  runVerification,
  signArtifactEnvelope,
  toJsonValue,
  verifyArtifactEnvelope,
  type ProducerBindings,
  type ProducerHost,
  type RedGreenTest,
  type SandboxExecutor,
  type SandboxJobBinding,
  type TestDiscovery,
} from "@pi-hec/verification";

const PLAN = Compile(VerificationPlanSchema);
const REPORT = Compile(VerdictReportSchema);

export type VerifyCandidateInput = {
  planEnvelope: ArtifactEnvelope<JsonValue>;
  controlPublicKey: KeyObject;
  verifierPrivateKey: KeyObject;
  verifierKeyId: string;
  verifierCertDigest: ObjectDigest;
  signedAt: string;
  evidenceRecords?: readonly EvidenceRecord[];
  observationsByCheck?: ReadonlyMap<string, readonly RunObservation[]>;
  host?: ProducerHost;
  bindings: ProducerBindings;
  subject: VerdictReport["subject"];
  integrityViolation?: boolean;
  sealsValid?: boolean;
  sandbox?: SandboxExecutor;
  sandboxExecution?: SandboxJobBinding;
  gaming?: { sealed: TestDiscovery; candidate: TestDiscovery };
  redGreen?: readonly RedGreenTest[];
};

export type VerifyCandidateResult = {
  envelope: ArtifactEnvelope<JsonValue>;
  report: VerdictReport;
};

function isVerificationPlan(payload: JsonValue): payload is VerificationPlan {
  return PLAN.Check(payload);
}

function requirePlan(payload: JsonValue): VerificationPlan {
  if (!isVerificationPlan(payload)) {
    throw new Error("verification plan payload is invalid");
  }
  return payload;
}

export async function verifyCandidate(input: VerifyCandidateInput): Promise<VerifyCandidateResult> {
  if (!verifyArtifactEnvelope(input.planEnvelope, input.controlPublicKey)) {
    throw new Error("verification plan signature is invalid");
  }
  if (input.planEnvelope.schemaName !== "VerificationPlan") {
    throw new Error("verification plan payload is invalid");
  }
  const plan = requirePlan(input.planEnvelope.payload);
  const result = await runVerification({
    plan,
    planObjectDigest: envelopeDigest(input.planEnvelope),
    evidenceRecords: input.evidenceRecords ?? [],
    ...(input.observationsByCheck === undefined
      ? {}
      : { observationsByCheck: input.observationsByCheck }),
    host: input.host ?? memoryHost({}),
    bindings: input.bindings,
    subject: input.subject,
    integrityViolation: input.integrityViolation === true,
    sealsValid: input.sealsValid !== false,
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    ...(input.sandboxExecution === undefined ? {} : { sandboxExecution: input.sandboxExecution }),
    ...(input.gaming === undefined ? {} : { gaming: input.gaming }),
    ...(input.redGreen === undefined ? {} : { redGreen: input.redGreen }),
  });
  if (!REPORT.Check(result.report)) {
    throw new Error("verdict report failed schema validation");
  }
  const envelope = signArtifactEnvelope(
    "VerdictReport",
    toJsonValue(result.report),
    input.verifierPrivateKey,
    input.verifierKeyId,
    input.verifierCertDigest,
    input.signedAt,
  );
  return { envelope, report: result.report };
}
