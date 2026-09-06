import type {
  CheckNode,
  EvidenceRecord,
  RunObservation,
  VerificationPlan,
  VerdictReport,
} from "@pi-hec/contracts";
import { assessAll, type AssessContext } from "./assess.js";
import { compileVerdictReport } from "../verdict.js";
import { PlanError } from "../plan/errors.js";
import { topologicalChecks } from "../plan/dag.js";
import { isCommandRecipe } from "../producers/helpers.js";
import { productionProducers } from "../producers/registry.js";
import { producerIdsForStdout } from "../producers/route.js";
import {
  networkCapabilityUnavailableExecutor,
  type SandboxExecutor,
} from "../producers/sandbox-exec.js";
import {
  buildSignedSandboxJob,
  executionGate,
  type SandboxJobBinding,
} from "../producers/sandbox-job.js";
import type {
  ArtifactStore,
  EvidenceProducer,
  ProducerBindings,
  ProducerHost,
} from "../producers/types.js";
import { memoryArtifacts } from "../producers/types.js";
import { detectGaming, type TestDiscovery } from "./gaming.js";
import { evaluateRedGreen, type RedGreenTest } from "./red-green.js";
import { makeEvidenceRecord } from "../producers/record.js";
import { stdoutText, lastObservation } from "../producers/parse-support.js";
import { subjectFor } from "../producers/types.js";

export type RunVerificationInput = {
  plan: VerificationPlan;
  planObjectDigest: VerificationPlan["baselineSealObjectDigest"];
  evidenceRecords: readonly EvidenceRecord[];
  observationsByCheck?: ReadonlyMap<string, readonly RunObservation[]>;
  host: ProducerHost;
  artifacts?: ArtifactStore;
  bindings: ProducerBindings;
  subject: VerdictReport["subject"];
  integrityViolation: boolean;
  sealsValid: boolean;
  unresolvedBlockers?: boolean;
  sandbox?: SandboxExecutor;
  sandboxExecution?: SandboxJobBinding;
  producerIds?: ReadonlySet<string>;
  mutatedEvidenceIds?: ReadonlySet<string>;
  gaming?: { sealed: TestDiscovery; candidate: TestDiscovery };
  redGreen?: readonly RedGreenTest[];
  evidenceEnvelopes?: AssessContext["evidenceEnvelopes"];
  envelopePublicKey?: AssessContext["envelopePublicKey"];
};

export type RunVerificationResult = {
  report: VerdictReport;
  evidence: readonly EvidenceRecord[];
};

export async function runVerification(input: RunVerificationInput): Promise<RunVerificationResult> {
  const artifacts = input.artifacts ?? memoryArtifacts({});
  const producers = productionProducers(input.host, artifacts, input.bindings);
  const producerById = new Map(producers.map((item) => [item.id, item]));
  const collected: EvidenceRecord[] = [...input.evidenceRecords];
  const sandbox = input.sandbox ?? networkCapabilityUnavailableExecutor();
  const ordered = topologicalChecks(input.plan.checks);
  for (const check of ordered) {
    const observations = await observationsFor(check, input, sandbox);
    try {
      collected.push(...(await parseCheck(check, observations, producerById, artifacts)));
    } catch {
      continue;
    }
  }
  if (input.gaming !== undefined) {
    collected.push(
      ...gamingEvidence(input.gaming.sealed, input.gaming.candidate, input.plan, input.bindings),
    );
  }
  if (input.redGreen !== undefined) {
    collected.push(...redGreenEvidence(input.redGreen, input.plan, input.bindings));
  }
  const assessContext: AssessContext = {
    baselineSealObjectDigest: input.bindings.baselineSealObjectDigest,
    candidateManifestObjectDigest: input.bindings.candidateManifestObjectDigest,
    environmentSealObjectDigest: input.bindings.environmentSealObjectDigest,
    producerIds: input.producerIds ?? new Set(producers.map((item) => item.id)),
    artifacts,
    ...(input.mutatedEvidenceIds === undefined
      ? {}
      : { mutatedEvidenceIds: input.mutatedEvidenceIds }),
    ...(input.evidenceEnvelopes === undefined
      ? {}
      : { evidenceEnvelopes: input.evidenceEnvelopes }),
    ...(input.envelopePublicKey === undefined
      ? {}
      : { envelopePublicKey: input.envelopePublicKey }),
  };
  const assessments = assessAll(collected, assessContext);
  const gamingBlocker =
    input.gaming !== undefined &&
    detectGaming(input.gaming.sealed, input.gaming.candidate).length > 0;
  const report = compileVerdictReport({
    plan: input.plan,
    planObjectDigest: input.planObjectDigest,
    evidence: collected,
    assessments,
    subject: input.subject,
    integrityViolation: input.integrityViolation,
    sealsValid: input.sealsValid,
    unresolvedBlockers: input.unresolvedBlockers === true || gamingBlocker,
  });
  return { report, evidence: collected };
}

async function observationsFor(
  check: CheckNode,
  input: RunVerificationInput,
  sandbox: SandboxExecutor,
): Promise<readonly RunObservation[]> {
  const existing = input.observationsByCheck?.get(check.id);
  if (existing !== undefined) {
    return existing;
  }
  if (!isCommandRecipe(check.recipe)) {
    return [];
  }
  const gate = executionGate(check.approval);
  if (gate === "wait" || gate === "deny") {
    return [{ attempt: 1, state: "ERROR", durationMs: 0 }];
  }
  if (input.sandboxExecution === undefined) {
    return [{ attempt: 1, state: "ERROR", durationMs: 0 }];
  }
  try {
    const signed = buildSignedSandboxJob(check.recipe, check, input.sandboxExecution);
    const result = await sandbox.run({
      spec: check.recipe,
      resolved: signed.resolved,
      resolvedEnvelopeDigest: signed.resolvedEnvelopeDigest,
      jobEnvelope: signed.jobEnvelope,
      networkRequired: check.recipe.network !== "NONE",
    });
    return result.observations;
  } catch (error) {
    if (error instanceof PlanError) {
      return [{ attempt: 1, state: "ERROR", durationMs: 0 }];
    }
    throw error;
  }
}

async function parseCheck(
  check: CheckNode,
  observations: readonly RunObservation[],
  producers: ReadonlyMap<string, EvidenceProducer>,
  artifacts: ArtifactStore,
): Promise<readonly EvidenceRecord[]> {
  const collected: EvidenceRecord[] = [];
  const ids = new Set<string>();
  if (isCommandRecipe(check.recipe)) {
    const last = lastObservation(observations);
    const text = last === undefined ? "" : `${stdoutText(last, artifacts)}\n`;
    for (const id of producerIdsForStdout(text)) {
      ids.add(id);
    }
  } else if ("intrinsicCheckId" in check.recipe) {
    const intrinsic = check.recipe.intrinsicCheckId;
    for (const producer of producers.values()) {
      if (intrinsic.startsWith(producer.id) || intrinsic.includes(producer.id)) {
        ids.add(producer.id);
      }
    }
  }
  if (ids.size === 0) {
    ids.add("generic-process");
  } else if (isCommandRecipe(check.recipe) && !ids.has("generic-process")) {
    ids.add("generic-process");
  }
  for (const id of ids) {
    const producer = producers.get(id);
    if (producer === undefined) {
      continue;
    }
    try {
      collected.push(...(await producer.parse(check, observations)));
    } catch {
      continue;
    }
  }
  return collected;
}

function firstObligationId(plan: VerificationPlan): EvidenceRecord["obligationId"] {
  const first = plan.obligations[0];
  if (first === undefined) {
    throw new Error("verification plan has no obligations");
  }
  return first.id;
}

function gamingEvidence(
  sealed: TestDiscovery,
  candidate: TestDiscovery,
  plan: VerificationPlan,
  bindings: ProducerBindings,
): EvidenceRecord[] {
  const findings = detectGaming(sealed, candidate);
  if (findings.length === 0) {
    return [];
  }
  const obligationId = firstObligationId(plan);
  const check = plan.checks[0];
  const subject =
    check === undefined
      ? {
          kind: "CANDIDATE" as const,
          candidateManifestObjectDigest: bindings.candidateManifestObjectDigest,
        }
      : subjectFor(check, bindings);
  return [
    makeEvidenceRecord({
      obligationId,
      relation: "NEUTRAL",
      origin: "VERIFIER",
      independenceGroup: "gaming",
      oracle: "EXPLICIT_EXPECTATION",
      baselineSealObjectDigest: bindings.baselineSealObjectDigest,
      subject,
      producerId: "generic-process",
      producerVersionObjectDigest: bindings.environmentSealObjectDigest,
      environmentSealObjectDigest: bindings.environmentSealObjectDigest,
      observations: [],
      artifactObjectDigests: [],
      salt: findings.map((item) => item.code).join(","),
    }),
  ];
}

function redGreenEvidence(
  tests: readonly RedGreenTest[],
  plan: VerificationPlan,
  bindings: ProducerBindings,
): EvidenceRecord[] {
  const obligationId = firstObligationId(plan);
  const out: EvidenceRecord[] = [];
  for (const test of tests) {
    const result = evaluateRedGreen(test);
    if (result === "reproduction") {
      out.push(
        makeEvidenceRecord({
          obligationId,
          relation: "SUPPORTS",
          origin: "VERIFIER",
          independenceGroup: "red-green",
          oracle: "RED_GREEN",
          baselineSealObjectDigest: bindings.baselineSealObjectDigest,
          subject: {
            kind: "CANDIDATE",
            candidateManifestObjectDigest: bindings.candidateManifestObjectDigest,
          },
          producerId: "generic-process",
          producerVersionObjectDigest: bindings.environmentSealObjectDigest,
          environmentSealObjectDigest: bindings.environmentSealObjectDigest,
          observations: [...test.candidateObservations],
          artifactObjectDigests: [],
          salt: `${test.name}:${result}:${test.bytesDigest}`,
        }),
      );
      continue;
    }
    const relation = result === "not-reproduction" ? "NEUTRAL" : "REFUTES";
    out.push(
      makeEvidenceRecord({
        obligationId,
        relation,
        origin: "VERIFIER",
        independenceGroup: "red-green",
        oracle: "RED_GREEN",
        baselineSealObjectDigest: bindings.baselineSealObjectDigest,
        subject: {
          kind: "CANDIDATE",
          candidateManifestObjectDigest: bindings.candidateManifestObjectDigest,
        },
        producerId: "generic-process",
        producerVersionObjectDigest: bindings.environmentSealObjectDigest,
        environmentSealObjectDigest: bindings.environmentSealObjectDigest,
        observations: [...test.candidateObservations],
        artifactObjectDigests: [],
        salt: `${test.name}:${result}:${test.bytesDigest}`,
      }),
    );
  }
  return out;
}
