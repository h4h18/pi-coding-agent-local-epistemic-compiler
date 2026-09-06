import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import {
  payloadDigest,
  signatureInputDigest,
  type ArtifactEnvelope,
  type Digest,
  type EnvelopeSignature,
  type JsonValue,
  type ObjectDigest,
  type ResolvedCommandSpec,
  type SandboxJob,
  type SecretInjectionGrant,
} from "@pi-hec/contracts";
import type { RecordingExec } from "@pi-hec/sandbox";
import {
  NonceCache,
  StaticIdentityStore,
  type CertificatePrincipalRecord,
} from "@pi-hec/security";

export { toJsonObject, toJsonValue } from "@pi-hec/contracts";

export function recordingExec(): RecordingExec {
  const calls: RecordingExec["calls"] = [];
  return {
    calls,
    execFile(file, args) {
      calls.push({ file, args: [...args] });
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    },
  };
}

export const DIGEST = `sha256:${"ab".repeat(32)}` as Digest;
export const OBJECT_DIGEST = DIGEST as ObjectDigest;
export const RUN = "run_01234567-89ab-7cde-8f01-23456789abcd";
export const OP = "op_01234567-89ab-7cde-8f01-23456789abcd";
export const PROJ = "proj1";
export const RUNNER = "runner-1";
export const CERT_SERIAL = "aa05";
export const TS = "2026-08-28T00:00:00.000Z";
export const TS_LATER = "2026-08-28T00:02:00.000Z";
export const TS_EXPIRED = "2026-08-27T23:00:00.000Z";
export const NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const CANARY = "CANARY_SECRET_VALUE_pi-hec-test";

export type KeyBundle = {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
  certDigest: ObjectDigest;
};

export function keyBundle(keyId: string): KeyBundle {
  const pair = generateKeyPairSync("ed25519");
  const spki = Buffer.from(pair.publicKey.export({ type: "spki", format: "der" }));
  const digest = `sha256:${createHash("sha256").update(spki).digest("hex")}` as ObjectDigest;
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    keyId,
    certDigest: digest,
  };
}


export function signPayload(
  schemaName: string,
  payload: JsonValue,
  signer: KeyBundle,
  signedAt: string,
): ArtifactEnvelope<JsonValue> {
  const digest = payloadDigest({ schemaName, schemaVersion: 1, payload });
  const input = signatureInputDigest({
    schemaName,
    schemaVersion: 1,
    payloadDigest: digest,
    keyId: signer.keyId,
    algorithm: "Ed25519",
    signedAt,
    signerCertificateObjectDigest: signer.certDigest,
  });
  const signatureBytes = cryptoSign(null, Buffer.from(input, "utf8"), signer.privateKey);
  const signature: EnvelopeSignature = {
    keyId: signer.keyId,
    algorithm: "Ed25519",
    signedAt,
    signerCertificateObjectDigest: signer.certDigest,
    signature: signatureBytes.toString("base64"),
  };
  return {
    schemaName,
    schemaVersion: 1,
    payload,
    payloadDigest: digest,
    signatures: [signature],
  };
}

export function makeJob(overrides: Record<string, unknown> = {}): SandboxJob {
  const job: SandboxJob = {
    schemaVersion: 1,
    projectId: PROJ,
    runId: RUN,
    operationId: OP,
    leaseGeneration: 1,
    targetRunnerId: RUNNER,
    phase: "CANDIDATE",
    resolvedCommandSpecObjectDigest: OBJECT_DIGEST,
    approvalOrStandingPolicyObjectDigest: OBJECT_DIGEST,
    inputTreeRootDigest: DIGEST,
    environmentRecipeObjectDigest: OBJECT_DIGEST,
    sandboxImageObjectDigest: OBJECT_DIGEST,
    safetyProfileObjectDigest: OBJECT_DIGEST,
    secretInjectionGrantObjectDigests: [],
    outputPolicy: {
      stdoutBytes: 4096,
      stderrBytes: 4096,
      artifactBytes: 65536,
      allowedArtifactGlobs: ["out/**"],
    },
    issuedAt: TS,
    expiresAt: TS_LATER,
    nonce: NONCE,
  };
  return { ...job, ...overrides };
}

export function makeCommand(executablePath = "/usr/bin/true"): ResolvedCommandSpec {
  return {
    schemaVersion: 1,
    sourceCommandObjectDigest: OBJECT_DIGEST,
    executablePath,
    executableDigest: DIGEST,
    argv: [],
    workingDirectory: "workspace",
    environment: {},
    secretHandles: [],
    networkDestinations: [],
    readOnlyMounts: [],
    writableRoots: ["out"],
    sandboxImageObjectDigest: OBJECT_DIGEST,
    safetyProfileObjectDigest: OBJECT_DIGEST,
  };
}

export function makeGrant(overrides: Record<string, unknown> = {}): SecretInjectionGrant {
  const grant: SecretInjectionGrant = {
    schemaVersion: 1,
    grantId: "grant-canary-1",
    projectId: PROJ,
    runId: RUN,
    operationId: OP,
    secretHandle: "secret-canary",
    targetRunnerId: RUNNER,
    targetProcessDigest: DIGEST,
    destination: { kind: "environment", name: "CANARY_TOKEN" },
    permittedNetworkDestinations: [],
    issuedAt: TS,
    expiresAt: TS_LATER,
    nonce: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  };
  return { ...grant, ...overrides };
}

export function runnerRecord(bundle: KeyBundle): CertificatePrincipalRecord {
  return {
    principalId: RUNNER,
    identityKind: "runner",
    certificateSerial: "aa05",
    spkiSha256: bundle.certDigest.slice("sha256:".length),
    revokedAt: undefined,
    notAfter: "2099-01-01T00:00:00.000Z",
    audiences: ["runner"],
    ed25519PublicKey: bundle.publicKey,
  };
}

export function identityStore(bundle: KeyBundle, revoked = false): StaticIdentityStore {
  const record = runnerRecord(bundle);
  return new StaticIdentityStore({
    records: [{ ...record, revokedAt: revoked ? TS : undefined }],
    grants: {
      [RUNNER]: [
        {
          projectId: PROJ,
          roles: ["runner"],
          grantObjectDigest: OBJECT_DIGEST,
          revokedAt: undefined,
        },
      ],
    },
    projects: [{ projectId: PROJ, grantObjectDigest: OBJECT_DIGEST }],
  });
}

export function freshNonceCache(): NonceCache {
  return new NonceCache(() => Date.parse(TS));
}
