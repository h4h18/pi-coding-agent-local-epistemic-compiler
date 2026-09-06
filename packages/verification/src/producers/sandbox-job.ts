import type { KeyObject } from "node:crypto";
import {
  toJsonValue,
  type ArtifactEnvelope,
  type CheckNode,
  type CommandSpec,
  type Digest,
  type JsonValue,
  type ObjectDigest,
  type ResolvedCommandSpec,
  type SandboxJob,
} from "@pi-hec/contracts";
import {
  bindCommandSpecEnvelope,
  bindResolvedCommandEnvelope,
  resolveCommandSpec,
  type SealedImageIndex,
} from "../plan/command-authority.js";
import { envelopeDigest, signArtifactEnvelope } from "../plan/envelope.js";
import { mintGeneralId } from "../plan/ids.js";

export type SandboxJobSigner = {
  privateKey: KeyObject;
  keyId: string;
  certDigest: ObjectDigest;
  signedAt: string;
  expiresAt: string;
};

export type SandboxJobIdentity = {
  projectId: string;
  runId: SandboxJob["runId"];
  operationId: SandboxJob["operationId"];
  leaseGeneration: number;
  targetRunnerId: string;
  inputTreeRootDigest: Digest;
  environmentRecipeObjectDigest: ObjectDigest;
  approvalOrStandingPolicyObjectDigest: ObjectDigest;
};

export type SandboxJobBinding = {
  image: SealedImageIndex;
  signer: SandboxJobSigner;
  identity: SandboxJobIdentity;
};

export type SignedSandboxCommand = {
  resolved: ResolvedCommandSpec;
  resolvedEnvelopeDigest: ObjectDigest;
  commandEnvelopeDigest: ObjectDigest;
  jobEnvelope: ArtifactEnvelope<JsonValue>;
};

export function executionGate(approval: CheckNode["approval"]): "run" | "wait" | "deny" {
  switch (approval) {
    case "AUTO":
      return "run";
    case "REQUIRE_USER":
      return "wait";
    case "DENY":
      return "deny";
    default: {
      const exhaustive: never = approval;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function buildSignedSandboxJob(
  spec: CommandSpec,
  check: CheckNode,
  binding: SandboxJobBinding,
): SignedSandboxCommand {
  const commandBound = bindCommandSpecEnvelope(
    spec,
    binding.signer.privateKey,
    binding.signer.keyId,
    binding.signer.certDigest,
    binding.signer.signedAt,
  );
  const resolved = resolveCommandSpec(spec, commandBound.digest, binding.image);
  const resolvedBound = bindResolvedCommandEnvelope(
    resolved,
    binding.signer.privateKey,
    binding.signer.keyId,
    binding.signer.certDigest,
    binding.signer.signedAt,
  );
  const job: SandboxJob = {
    schemaVersion: 1,
    projectId: binding.identity.projectId,
    runId: binding.identity.runId,
    operationId: binding.identity.operationId,
    leaseGeneration: binding.identity.leaseGeneration,
    targetRunnerId: binding.identity.targetRunnerId,
    phase: phaseFor(check.subject),
    resolvedCommandSpecObjectDigest: resolvedBound.digest,
    approvalOrStandingPolicyObjectDigest: binding.identity.approvalOrStandingPolicyObjectDigest,
    inputTreeRootDigest: binding.identity.inputTreeRootDigest,
    environmentRecipeObjectDigest: binding.identity.environmentRecipeObjectDigest,
    sandboxImageObjectDigest: resolved.sandboxImageObjectDigest,
    safetyProfileObjectDigest: resolved.safetyProfileObjectDigest,
    secretInjectionGrantObjectDigests: [],
    outputPolicy: {
      stdoutBytes: 65536,
      stderrBytes: 65536,
      artifactBytes: 1_048_576,
      allowedArtifactGlobs: ["out/**"],
    },
    issuedAt: binding.signer.signedAt,
    expiresAt: binding.signer.expiresAt,
    nonce: mintGeneralId("nonce", `${check.id}:${resolvedBound.digest}`),
  };
  const jobEnvelope = signArtifactEnvelope(
    "SandboxJob",
    toJsonValue(job),
    binding.signer.privateKey,
    binding.signer.keyId,
    binding.signer.certDigest,
    binding.signer.signedAt,
  );
  return {
    resolved,
    resolvedEnvelopeDigest: resolvedBound.digest,
    commandEnvelopeDigest: envelopeDigest(commandBound.envelope),
    jobEnvelope,
  };
}

function phaseFor(subject: CheckNode["subject"]): SandboxJob["phase"] {
  switch (subject) {
    case "BASELINE":
      return "BASELINE";
    case "CANDIDATE":
      return "CANDIDATE";
    case "PAIRED":
      return "ADDITIONAL_CHECK";
    default: {
      const exhaustive: never = subject;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}
