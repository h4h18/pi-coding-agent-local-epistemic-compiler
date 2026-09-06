import {
  createCipheriv,
  createDecipheriv,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { Compile } from "typebox/compile";
import {
  SandboxJobResultSchema,
  SandboxJobSchema,
  canonicalize,
  envelopeObjectDigest,
  payloadDigest,
  sha256Utf8,
  signatureInputDigest,
  taggedHash,
  toJsonValue,
  type ArtifactEnvelope,
  type Digest,
  type EnvironmentRecipe,
  type EnvelopeSignature,
  type JsonValue,
  type MaybePromise,
  type ObjectDigest,
  type PayloadDigest,
  type ResolvedCommandSpec,
  type SandboxJob,
  type SandboxJobResult,
  type SandboxResourceUsage,
} from "@pi-hec/contracts";
import type { IdentityStorePort } from "@pi-hec/security";

export const REASON = {
  extraProperties: "extra-properties",
  signatureInvalid: "signature-invalid",
  expired: "expired",
  nonceReplay: "nonce-replay",
  leaseMismatch: "lease-mismatch",
  audienceMismatch: "audience-mismatch",
  grantMissing: "grant-missing",
  imageDigestMismatch: "image-digest-mismatch",
  inputRootMismatch: "input-root-mismatch",
  schemaInvalid: "schema-invalid",
  capabilityAbsent: "capability-absent",
  outputPolicyViolation: "output-policy-violation",
  attestationMismatch: "attestation-mismatch",
} as const;

export type ReasonCode = (typeof REASON)[keyof typeof REASON];

export type SafetyProfile = {
  cpuMillis: number;
  memoryBytes: number;
  processCount: number;
  diskBytes: number;
  wallClockMillis: number;
  stdoutBytes: number;
  stderrBytes: number;
};

export type SandboxImageRef = {
  platform: EnvironmentRecipe["platform"];
  digest: ObjectDigest;
  path: string;
  provenancePath: string;
};

export type SealedSecret = {
  version: 1;
  ephemeralX25519PublicKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
};

export type CapabilityProbe = { available: true } | { available: false; missing: string };

export type VmSession =
  | { kind: "qemu-guest"; overlayPath: string }
  | { kind: "hyperv-guest"; vmName: string };

export type ExecFilePort = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type RecordingExec = {
  calls: Array<{ file: string; args: readonly string[] }>;
  execFile: ExecFilePort;
};

export type HypervisorExec = ExecFilePort | RecordingExec;

export type JobAttestation = {
  schemaVersion: 1;
  jobNonce: string;
  ephemeralSpkiSha256: string;
  runnerCertificateObjectDigest: ObjectDigest;
  issuedAt: string;
  expiresAt: string;
  signature: string;
};

export type SignedSandboxJobResult = {
  envelope: ArtifactEnvelope<SandboxJobResult>;
  attestation: JobAttestation;
  ephemeralPublicKey: KeyObject;
};

export type SandboxBackend = {
  probe(image: SandboxImageRef): MaybePromise<CapabilityProbe>;
  run(job: SandboxJob, context: SandboxExecutionContext): Promise<SandboxJobResult>;
};

export type OciBackendPort = {
  probeInsideVm(session: VmSession | undefined, evidence?: { ns: number }): MaybePromise<CapabilityProbe>;
};

export type SandboxExecutionContext = {
  now: string;
  runnerId: string;
  runnerPrivateKey: KeyObject;
  runnerCertificateDigest: ObjectDigest;
  runnerCertificateSerial: string;
  controlPublicKey: KeyObject;
  identityStore: IdentityStorePort;
  consumedJobNonces: Set<string>;
  currentLeaseGeneration: number;
  expectedInputRoot: Digest;
  expectedImageDigest: ObjectDigest;
  recipe: EnvironmentRecipe;
  command: ResolvedCommandSpec;
  safetyProfile: SafetyProfile;
  networkDestinations: readonly string[];
  protocolCapabilities: ReadonlySet<string>;
  image: SandboxImageRef;
  sealedSecrets?: readonly {
    destination: { kind: "environment"; name: string } | { kind: "file"; relativePath: string; mode: "0400" };
    sealed: SealedSecret;
  }[];
  unsealPrivateKey?: KeyObject;
  pinnedIps?: ReadonlyMap<string, readonly string[]>;
  backends: {
    qemu: SandboxBackend;
    oci: OciBackendPort;
    hyperv: SandboxBackend;
    macos: SandboxBackend;
  };
};

export type EphemeralX25519 = {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyRaw: Uint8Array;
};

const HYPERVISOR_BINARIES = new Set([
  "qemu-system-x86_64",
  "qemu-system-x86_64.exe",
  "qemu-img",
  "qemu-img.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

const jobValidator = Compile(SandboxJobSchema);
const resultValidator = Compile(SandboxJobResultSchema);

export function hypervisorBinaryAllowed(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  const base = normalized.split("/").pop() ?? normalized;
  return HYPERVISOR_BINARIES.has(base.toLowerCase());
}

export function asExecPort(exec: HypervisorExec): ExecFilePort {
  if (typeof exec === "function") {
    return exec;
  }
  return (file, args, options) => exec.execFile(file, args, options);
}

export function objectDigestOf(value: JsonValue): ObjectDigest {
  return sha256Utf8(canonicalize(value)) as ObjectDigest;
}

export function evaluateSafety(
  usage: SandboxResourceUsage,
  profile: SafetyProfile,
  timedOut: boolean,
): "ok" | "safety-limit" | "timeout" {
  if (timedOut) {
    return "timeout";
  }
  if (usage.peakProcessCount > profile.processCount) {
    return "safety-limit";
  }
  if (usage.writtenBytes > profile.diskBytes) {
    return "safety-limit";
  }
  if (usage.peakMemoryBytes > profile.memoryBytes) {
    return "safety-limit";
  }
  if (usage.cpuMillis > profile.cpuMillis) {
    return "safety-limit";
  }
  if (usage.wallClockMillis > profile.wallClockMillis) {
    return "safety-limit";
  }
  return "ok";
}

export function boundOutput(bytes: Uint8Array, limit: number): { bytes: Uint8Array; truncated: boolean } {
  if (bytes.byteLength <= limit) {
    return { bytes, truncated: false };
  }
  return { bytes: bytes.subarray(0, limit), truncated: true };
}

export function guestEnvironment(input: {
  platform: EnvironmentRecipe["platform"];
  commandEnvironment: Readonly<Record<string, string>>;
  hostEnvironment: Readonly<Record<string, string>>;
}): Record<string, string> {
  void input.hostEnvironment;
  const pathValue =
    input.platform === "windows" ? String.raw`C:\sandbox\bin` : "/usr/bin:/bin";
  const env: Record<string, string> = {
    PATH: pathValue,
    HOME: "/sandbox",
    TZ: "UTC",
  };
  const allow = new Set(["LANG", "LC_ALL", "TZ", "TERM"]);
  for (const [key, value] of Object.entries(input.commandEnvironment)) {
    if (!allow.has(key)) {
      continue;
    }
    if (/proxy|secret|token|credential|cas_|control_/i.test(`${key}=${value}`)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

export function generateEphemeralX25519(): EphemeralX25519 {
  const pair = generateKeyPairSync("x25519");
  const publicKeyRaw = Uint8Array.from(pair.publicKey.export({ type: "spki", format: "der" }));
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyRaw };
}

export function sealSecretToRecipient(plaintext: Uint8Array, recipientPublicKeyRaw: Uint8Array): SealedSecret {
  const ephemeral = generateKeyPairSync("x25519");
  const recipient = createPublicKey({
    key: Buffer.from(recipientPublicKeyRaw),
    type: "spki",
    format: "der",
  });
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, "pi-hec-secret-seal-v1", "aes-256-gcm", 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ephSpki = Buffer.from(ephemeral.publicKey.export({ type: "spki", format: "der" }));
  key.fill(0);
  shared.fill(0);
  return {
    version: 1,
    ephemeralX25519PublicKey: ephSpki.toString("base64url"),
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

export function unsealSecret(sealed: SealedSecret, recipientPrivateKey: KeyObject): Buffer {
  const eph = createPublicKey({
    key: Buffer.from(sealed.ephemeralX25519PublicKey, "base64url"),
    type: "spki",
    format: "der",
  });
  const shared = diffieHellman({ privateKey: recipientPrivateKey, publicKey: eph });
  const key = Buffer.from(hkdfSync("sha256", shared, "pi-hec-secret-seal-v1", "aes-256-gcm", 32));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
    decipher.final(),
  ]);
  key.fill(0);
  shared.fill(0);
  return plain;
}

export { redactSecretMaterial } from "./redact.js";

export function sandboxOutputTreeDigest(
  entries: readonly { path: string; digest: Digest; byteLength: number }[],
): Digest {
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return taggedHash("sandbox-output-tree", 1, {
    entries: sorted.map((entry) => ({
      path: entry.path,
      digest: entry.digest,
      byteLength: entry.byteLength,
    })),
  });
}

type EnvelopeShape = {
  schemaName: string;
  schemaVersion: number;
  payload: unknown;
  payloadDigest: string;
  signatures: readonly EnvelopeSignature[];
};

function isEnvelopeSignature(value: unknown): value is EnvelopeSignature {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as { [key: string]: unknown };
  return (
    typeof record.keyId === "string" &&
    (record.algorithm === "Ed25519" || record.algorithm === "ECDSA-P256-SHA256") &&
    typeof record.signedAt === "string" &&
    typeof record.signerCertificateObjectDigest === "string" &&
    typeof record.signature === "string"
  );
}

function parseEnvelope(input: unknown): EnvelopeShape | undefined {
  if (input === null || typeof input !== "object") {
    return undefined;
  }
  const record = input as { [key: string]: unknown };
  if (typeof record.schemaName !== "string" || typeof record.schemaVersion !== "number") {
    return undefined;
  }
  if (typeof record.payloadDigest !== "string" || !Array.isArray(record.signatures)) {
    return undefined;
  }
  const signatures: EnvelopeSignature[] = [];
  for (const entry of record.signatures) {
    if (!isEnvelopeSignature(entry)) {
      return undefined;
    }
    signatures.push(entry);
  }
  return {
    schemaName: record.schemaName,
    schemaVersion: record.schemaVersion,
    payload: record.payload,
    payloadDigest: record.payloadDigest,
    signatures,
  };
}

function verifyDetached(envelope: EnvelopeShape, publicKey: KeyObject): boolean {
  const payload = toJsonValue(envelope.payload);
  const digest: PayloadDigest = payloadDigest({
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payload,
  });
  if (digest !== envelope.payloadDigest) {
    return false;
  }
  const signature = envelope.signatures[0];
  if (signature === undefined || signature.algorithm !== "Ed25519") {
    return false;
  }
  const input = signatureInputDigest({
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payloadDigest: digest,
    keyId: signature.keyId,
    algorithm: signature.algorithm,
    signedAt: signature.signedAt,
    signerCertificateObjectDigest: signature.signerCertificateObjectDigest as ObjectDigest,
  });
  return cryptoVerify(null, Buffer.from(input, "utf8"), publicKey, Buffer.from(signature.signature, "base64"));
}

export function verifyEnvelopeSignature(envelope: unknown, publicKey: KeyObject): boolean {
  const parsed = parseEnvelope(envelope);
  if (parsed === undefined) {
    return false;
  }
  return verifyDetached(parsed, publicKey);
}

export function envelopePayload(envelope: unknown): unknown {
  return parseEnvelope(envelope)?.payload;
}

export function signEnvelope(
  schemaName: string,
  payload: JsonValue,
  privateKey: KeyObject,
  keyId: string,
  certDigest: ObjectDigest,
  signedAt: string,
): ArtifactEnvelope<JsonValue> {
  const digest = payloadDigest({ schemaName, schemaVersion: 1, payload });
  const input = signatureInputDigest({
    schemaName,
    schemaVersion: 1,
    payloadDigest: digest,
    keyId,
    algorithm: "Ed25519",
    signedAt,
    signerCertificateObjectDigest: certDigest,
  });
  const signatureBytes = cryptoSign(null, Buffer.from(input, "utf8"), privateKey);
  return {
    schemaName,
    schemaVersion: 1,
    payload,
    payloadDigest: digest,
    signatures: [
      {
        keyId,
        algorithm: "Ed25519",
        signedAt,
        signerCertificateObjectDigest: certDigest,
        signature: signatureBytes.toString("base64"),
      },
    ],
  };
}

function identityFromPayload(payload: unknown): {
  projectId: string;
  runId: SandboxJob["runId"];
  operationId: SandboxJob["operationId"];
  leaseGeneration: number;
} {
  const record = payload !== null && typeof payload === "object" ? (payload as { [key: string]: unknown }) : {};
  const projectId = typeof record.projectId === "string" ? record.projectId : "invalid";
  const runId =
    typeof record.runId === "string" ? (record.runId) : ("run_01234567-89ab-7cde-8f01-23456789abcd" as SandboxJob["runId"]);
  const operationId =
    typeof record.operationId === "string"
      ? (record.operationId)
      : ("op_01234567-89ab-7cde-8f01-23456789abcd" as SandboxJob["operationId"]);
  const leaseGeneration = typeof record.leaseGeneration === "number" ? record.leaseGeneration : 0;
  return { projectId, runId, operationId, leaseGeneration };
}

function jobObjectDigest(envelope: EnvelopeShape): ObjectDigest {
  return envelopeObjectDigest({
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payload: toJsonValue(envelope.payload),
    payloadDigest: envelope.payloadDigest as PayloadDigest,
    signatures: envelope.signatures,
  });
}

export function rejectedResult(input: {
  identity: ReturnType<typeof identityFromPayload>;
  jobDigest: ObjectDigest;
  reason: ReasonCode;
  evidence: JsonValue;
  completedAt: string;
}): SandboxJobResult {
  const result: SandboxJobResult = {
    schemaVersion: 1,
    outcome: "REJECTED",
    projectId: input.identity.projectId,
    runId: input.identity.runId,
    operationId: input.identity.operationId,
    leaseGeneration: input.identity.leaseGeneration,
    sandboxJobObjectDigest: input.jobDigest,
    reasonCode: input.reason,
    evidenceObjectDigest: objectDigestOf(input.evidence),
    completedAt: input.completedAt,
  };
  if (!resultValidator.Check(result)) {
    throw new Error("rejected result failed schema");
  }
  return result;
}

export function unknownResult(input: {
  identity: ReturnType<typeof identityFromPayload>;
  jobDigest: ObjectDigest;
  evidence: JsonValue;
  completedAt: string;
}): SandboxJobResult {
  const result: SandboxJobResult = {
    schemaVersion: 1,
    outcome: "OUTCOME_UNKNOWN",
    projectId: input.identity.projectId,
    runId: input.identity.runId,
    operationId: input.identity.operationId,
    leaseGeneration: input.identity.leaseGeneration,
    sandboxJobObjectDigest: input.jobDigest,
    lastEvidenceObjectDigest: objectDigestOf(input.evidence),
    completedAt: input.completedAt,
  };
  if (!resultValidator.Check(result)) {
    throw new Error("unknown result failed schema");
  }
  return result;
}

function signAttestation(
  attestation: Omit<JobAttestation, "signature">,
  runnerPrivateKey: KeyObject,
): JobAttestation {
  const canonical = canonicalize(toJsonValue(attestation));
  const signature = cryptoSign(null, Buffer.from(canonical, "utf8"), runnerPrivateKey).toString("base64");
  return { ...attestation, signature };
}

function signOutput(
  result: SandboxJobResult,
  context: SandboxExecutionContext,
  jobNonce: string,
): SignedSandboxJobResult {
  const ephemeral = generateKeyPairSync("ed25519");
  const spki = Buffer.from(ephemeral.publicKey.export({ type: "spki", format: "der" }));
  const ephemeralSpkiSha256 = createHash("sha256").update(spki).digest("hex");
  const certDigest = `sha256:${ephemeralSpkiSha256}` as ObjectDigest;
  const envelope = signEnvelope(
    "SandboxJobResult",
    toJsonValue(result),
    ephemeral.privateKey,
    `ephemeral-${ephemeralSpkiSha256.slice(0, 16)}`,
    certDigest,
    context.now,
  );
  const attestation = signAttestation(
    {
      schemaVersion: 1,
      jobNonce,
      ephemeralSpkiSha256,
      runnerCertificateObjectDigest: context.runnerCertificateDigest,
      issuedAt: context.now,
      expiresAt: new Date(Date.parse(context.now) + 15 * 60 * 1000).toISOString(),
    },
    context.runnerPrivateKey,
  );
  return {
    envelope: envelope as ArtifactEnvelope<SandboxJobResult>,
    attestation,
    ephemeralPublicKey: ephemeral.publicKey,
  };
}

function hasProjectGrant(context: SandboxExecutionContext, projectId: string): boolean {
  const spki = context.runnerCertificateDigest.startsWith("sha256:")
    ? context.runnerCertificateDigest.slice("sha256:".length)
    : context.runnerCertificateDigest;
  const record = context.identityStore.lookupBySerialAndSpki(context.runnerCertificateSerial, spki);
  if (record === undefined || record.revokedAt !== undefined) {
    return false;
  }
  const grants = context.identityStore.listGrants(context.runnerId);
  return grants.some((grant) => grant.projectId === projectId && grant.revokedAt === undefined);
}

async function dispatch(job: SandboxJob, context: SandboxExecutionContext): Promise<SandboxJobResult> {
  const identity = identityFromPayload(job);
  const digest = objectDigestOf(toJsonValue(job));
  switch (context.recipe.platform) {
    case "linux": {
      const backend = process.platform === "win32" ? context.backends.hyperv : context.backends.qemu;
      const probe = await backend.probe(context.image);
      if (!probe.available) {
        return unknownResult({
          identity,
          jobDigest: digest,
          evidence: { reason: REASON.capabilityAbsent, missing: probe.missing },
          completedAt: context.now,
        });
      }
      return backend.run(job, context);
    }
    case "windows": {
      const probe = await context.backends.hyperv.probe(context.image);
      if (!probe.available) {
        return unknownResult({
          identity,
          jobDigest: digest,
          evidence: { reason: REASON.capabilityAbsent, missing: probe.missing },
          completedAt: context.now,
        });
      }
      return context.backends.hyperv.run(job, context);
    }
    case "macos": {
      const probe = await context.backends.macos.probe(context.image);
      if (!probe.available) {
        return unknownResult({
          identity,
          jobDigest: digest,
          evidence: { reason: REASON.capabilityAbsent, missing: probe.missing },
          completedAt: context.now,
        });
      }
      return context.backends.macos.run(job, context);
    }
    default: {
      const exhaustive: never = context.recipe.platform;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function executeSandboxJob(
  envelopeInput: unknown,
  context: SandboxExecutionContext,
): Promise<SignedSandboxJobResult> {
  const parsed = parseEnvelope(envelopeInput);
  const fallbackIdentity = identityFromPayload(parsed?.payload);
  if (parsed === undefined || parsed.schemaName !== "SandboxJob") {
    return signOutput(
      rejectedResult({
        identity: fallbackIdentity,
        jobDigest: objectDigestOf({ reason: REASON.schemaInvalid }),
        reason: REASON.schemaInvalid,
        evidence: { reason: REASON.schemaInvalid },
        completedAt: context.now,
      }),
      context,
      "",
    );
  }
  const identity = identityFromPayload(parsed.payload);
  const digest = jobObjectDigest(parsed);
  const nonce = typeof (parsed.payload as { nonce?: unknown }).nonce === "string" ? (parsed.payload as { nonce: string }).nonce : "";
  if (!jobValidator.Check(parsed.payload)) {
    return signOutput(
      rejectedResult({
        identity,
        jobDigest: digest,
        reason: REASON.extraProperties,
        evidence: { reason: REASON.extraProperties },
        completedAt: context.now,
      }),
      context,
      nonce,
    );
  }
  if (!verifyDetached(parsed, context.controlPublicKey)) {
    return signOutput(
      rejectedResult({
        identity,
        jobDigest: digest,
        reason: REASON.signatureInvalid,
        evidence: { reason: REASON.signatureInvalid },
        completedAt: context.now,
      }),
      context,
      nonce,
    );
  }
  const job = parsed.payload;
  if (context.consumedJobNonces.has(job.nonce)) {
    return signOutput(
      rejectedResult({
        identity,
        jobDigest: digest,
        reason: REASON.nonceReplay,
        evidence: { reason: REASON.nonceReplay },
        completedAt: context.now,
      }),
      context,
      job.nonce,
    );
  }
  context.consumedJobNonces.add(job.nonce);
  if (context.now < job.issuedAt || context.now > job.expiresAt || job.expiresAt <= job.issuedAt) {
    return signOutput(
      rejectedResult({
        identity,
        jobDigest: digest,
        reason: REASON.expired,
        evidence: { reason: REASON.expired },
        completedAt: context.now,
      }),
      context,
      job.nonce,
    );
  }
  if (job.targetRunnerId !== context.runnerId) {
    return signOutput(
      rejectedResult({
        identity,
        jobDigest: digest,
        reason: REASON.audienceMismatch,
        evidence: { reason: REASON.audienceMismatch },
        completedAt: context.now,
      }),
      context,
      job.nonce,
    );
  }
  if (!hasProjectGrant(context, job.projectId)) {
    return signOutput(
      rejectedResult({
        identity,
        jobDigest: digest,
        reason: REASON.grantMissing,
        evidence: { reason: REASON.grantMissing },
        completedAt: context.now,
      }),
      context,
      job.nonce,
    );
  }
  if (job.leaseGeneration !== context.currentLeaseGeneration) {
    return signOutput(
      rejectedResult({
        identity,
        jobDigest: digest,
        reason: REASON.leaseMismatch,
        evidence: { reason: REASON.leaseMismatch },
        completedAt: context.now,
      }),
      context,
      job.nonce,
    );
  }
  if (job.sandboxImageObjectDigest !== context.expectedImageDigest) {
    return signOutput(
      rejectedResult({
        identity,
        jobDigest: digest,
        reason: REASON.imageDigestMismatch,
        evidence: { reason: REASON.imageDigestMismatch },
        completedAt: context.now,
      }),
      context,
      job.nonce,
    );
  }
  if (job.inputTreeRootDigest !== context.expectedInputRoot) {
    return signOutput(
      rejectedResult({
        identity,
        jobDigest: digest,
        reason: REASON.inputRootMismatch,
        evidence: { reason: REASON.inputRootMismatch },
        completedAt: context.now,
      }),
      context,
      job.nonce,
    );
  }
  const result = await dispatch(job, context);
  return signOutput(result, context, job.nonce);
}
