import { generateKeyPairSync, createHash, type KeyObject } from "node:crypto";
import {
  asCheckId,
  asDigest,
  asObjectDigest,
  asObligationId,
  asRequirementId,
  asRunId,
  asSnapshotId,
  sha256Utf8,
  type BaselineSeal,
  type CheckNode,
  type CommandSpec,
  type EvidenceRecord,
  type ObjectDigest,
  type ProofObligation,
  type Requirement,
  type RunObservation,
  type VerificationPlan,
} from "@pi-hec/contracts";
import { observationSignature, type ProducerBindings, type SandboxJobBinding } from "../src/index.js";

export const DIGEST = asDigest("sha256:" + "ab".repeat(32));
export const OBJECT = asObjectDigest("sha256:" + "ab".repeat(32));
export const SNAP = asSnapshotId("snap_01234567-89ab-7cde-8f01-23456789abcd");
export const RUN = asRunId("run_01234567-89ab-7cde-8f01-23456789abcd");
export const TS = "2026-08-28T00:00:00.000Z";
export const REQ = asRequirementId("req_" + "a".repeat(52));
export const OBL = asObligationId("obl_" + "b".repeat(52));
export const CHECK = asCheckId("check_" + "c".repeat(52));

export const BINDINGS: ProducerBindings = {
  baselineSealObjectDigest: OBJECT,
  environmentSealObjectDigest: OBJECT,
  snapshotId: SNAP,
  snapshotRootDigest: DIGEST,
  candidateManifestObjectDigest: OBJECT,
};

export function seal(): BaselineSeal {
  return {
    schemaVersion: 1,
    runId: RUN,
    taskEnvelopeObjectDigest: OBJECT,
    snapshotId: SNAP,
    snapshotRootDigest: DIGEST,
    instructionManifestObjectDigest: OBJECT,
    skillManifestObjectDigest: OBJECT,
    environmentSealObjectDigest: OBJECT,
    commandPlanObjectDigest: OBJECT,
    baselineEvidenceRootDigest: DIGEST,
    exclusionManifestObjectDigest: OBJECT,
    verifierManifestObjectDigest: OBJECT,
    createdAt: TS,
  };
}

export function requirement(text = "feature must work"): Requirement {
  return {
    id: REQ,
    text,
    sourceRefs: [],
    priority: "MUST",
    state: "CLEAR",
    kind: "authoritative",
    source: "USER_EXPLICIT",
    normative: true,
  };
}

export function obligation(overrides: Partial<ProofObligation> = {}): ProofObligation {
  return {
    id: OBL,
    requirementIds: [REQ],
    claim: "feature holds",
    claimMode: "UNIVERSAL",
    kind: "FUNCTIONAL",
    mandatory: true,
    sourceRefs: [],
    prerequisites: [],
    ...overrides,
  };
}

export function commandSpec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    schemaVersion: 1,
    id: "cmd-test",
    authority: "VERIFIER_INTRINSIC",
    executable: "usr/bin/test-runner",
    argv: ["--ci"],
    workingDirectory: "repo",
    environment: {},
    secretHandles: [],
    network: "NONE",
    writableRoots: ["tmp"],
    timeoutPolicy: "SAFETY_BOUND",
    sourceRefs: [],
    ...overrides,
  };
}

export function observation(state: RunObservation["state"], attempt = 1, extra: Partial<RunObservation> = {}): RunObservation {
  return {
    attempt,
    state,
    durationMs: 10,
    ...extra,
  };
}

export function stableObservations(state: RunObservation["state"]): RunObservation[] {
  return [observation(state, 1), observation(state, 2), observation(state, 3)];
}

export function evidence(overrides: Partial<EvidenceRecord> & Pick<EvidenceRecord, "relation" | "origin">): EvidenceRecord {
  return {
    schemaVersion: 1,
    id: overrides.id ?? "ev-1",
    obligationId: overrides.obligationId ?? OBL,
    relation: overrides.relation,
    origin: overrides.origin,
    independenceGroup: overrides.independenceGroup ?? "g1",
    oracle: overrides.oracle ?? "EXPLICIT_EXPECTATION",
    baselineSealObjectDigest: overrides.baselineSealObjectDigest ?? OBJECT,
    subject: overrides.subject ?? { kind: "CANDIDATE", candidateManifestObjectDigest: OBJECT },
    producerId: overrides.producerId ?? "generic-process",
    producerVersionObjectDigest: overrides.producerVersionObjectDigest ?? OBJECT,
    environmentSealObjectDigest: overrides.environmentSealObjectDigest ?? OBJECT,
    observations: (overrides.observations ?? stableObservations("PASSED")).map((item) => observationSignature(item)),
    artifactObjectDigests: overrides.artifactObjectDigests ?? [],
  };
}

export function keyPair(): { privateKey: KeyObject; publicKey: KeyObject; keyId: string; certDigest: ObjectDigest } {
  const pair = generateKeyPairSync("ed25519");
  const spki = Buffer.from(pair.publicKey.export({ type: "spki", format: "der" }));
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    keyId: "verifier-1",
    certDigest: asObjectDigest(`sha256:${createHash("sha256").update(spki).digest("hex")}`),
  };
}

export function sandboxBinding(signer = keyPair()): SandboxJobBinding {
  return {
    image: {
      files: new Map([["usr/bin/test-runner", OBJECT]]),
      sandboxImageObjectDigest: OBJECT,
      safetyProfileObjectDigest: OBJECT,
    },
    signer: {
      privateKey: signer.privateKey,
      keyId: signer.keyId,
      certDigest: signer.certDigest,
      signedAt: TS,
      expiresAt: "2026-08-28T00:02:00.000Z",
    },
    identity: {
      projectId: "proj1",
      runId: RUN,
      operationId: "op_01234567-89ab-7cde-8f01-23456789abcd",
      leaseGeneration: 1,
      targetRunnerId: "runner-1",
      inputTreeRootDigest: DIGEST,
      environmentRecipeObjectDigest: OBJECT,
      approvalOrStandingPolicyObjectDigest: OBJECT,
    },
  };
}

export function emptyPlan(overrides: { obligations?: ProofObligation[]; checks?: CheckNode[] } = {}): VerificationPlan {
  return {
    schemaVersion: 1,
    planId: "plan-test",
    revision: 0,
    baselineSealObjectDigest: OBJECT,
    requirements: [],
    obligations: overrides.obligations ?? [obligation()],
    checks: overrides.checks ?? [],
    baselineSupplementObjectDigests: [],
  };
}

export { sha256Utf8 };
