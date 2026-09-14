import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  payloadDigest,
  sha256Utf8,
  type ObjectDigest,
  type ProjectPolicy,
} from "@pi-hec/contracts";
import {
  ARGON2ID_TEST_PARAMETERS,
  defaultControlMigrationsDir,
  openStateStore,
  type ArtifactInput,
  type HostAuthorityArtifactInput,
  type StateStore,
} from "@pi-hec/state-store";
import { createFilesystemCas, MemoryStorageRecordSink, neverOccupied } from "@pi-hec/cas";
import { ControlPlaneClient, type MutationSigner } from "@pi-hec/client";
import {
  ApprovalNonceRegistry,
  CompositeIdentityStore,
  NonceCache,
  StaticIdentityStore,
  constructPrincipalScope,
  generateNonce,
  mutationHeaders,
  parsePeerCertificate,
  signMutation,
  type CertificatePrincipalRecord,
} from "@pi-hec/security";
import { listenControlPlane, type ListeningControlPlane } from "../src/app.js";
import { BLOB_BODY_LIMIT, JSON_BODY_LIMIT } from "../src/config.js";
import { SqliteIdentityStore } from "../src/identity-store.js";
import { parseCaPrivateKey } from "../src/pki.js";
import { ProjectListingIdentityStore, expandOperationalPrincipalGrants, type AppContext } from "../src/orchestration/handlers.js";
import { Scheduler } from "../src/orchestration/scheduler.js";
import { generateTestPki, type IssuedCert, type TestPki } from "./fixtures/pki.js";

export const PROJECT_ID = "proj-alpha";
export const WORKSPACE_ID = "ws-proj-alpha";
export const RUNNER_ID = "runner-shared";
export const RUN_ID = "run_01900000-0000-7000-8000-0000000000aa";

export const HOST_SIGNER = digestOf("host-signer-cert");
export const HOST_POLICY = digestOf("host-policy");
export const HOST_CAPABILITY = digestOf("host-runner-capability");
export const HOST_GRANT_POLICY = digestOf("host-runner-grant-policy");

let nonceCounter = 0;

export function digestOf(label: string): ObjectDigest {
  return sha256Utf8(label) as ObjectDigest;
}

function nextNonce(): string {
  nonceCounter += 1;
  return nonceCounter.toString(16).padStart(24, "0");
}

export function opId(suffix: number): `op_${string}` {
  return `op_01900000-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
}

export function approvalId(suffix: number): `approval_${string}` {
  return `approval_01900000-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
}

function hostArtifact(
  objectDigest: string,
  label: string,
  createdAt: string,
): HostAuthorityArtifactInput {
  return {
    objectDigest,
    schemaName: "HostAuthority",
    mediaType: "application/json",
    byteSize: 32,
    encryptionKeyId: `host-key:${label}`,
    encryptionNonce: nextNonce(),
    signatureKeyId: "host-sign",
    signature: "c2ln",
    createdAt,
  };
}

function sqlArtifact(
  digest: ObjectDigest,
  schemaName: string | null,
  label: string,
  createdAt: string,
): ArtifactInput {
  return {
    digest,
    schemaName,
    mediaType: "application/json",
    byteSize: 16,
    classification: "internal",
    encryptionAlgorithm: "AES-256-GCM",
    encryptionKeyId: `cas:${label}`,
    encryptionNonce: nextNonce(),
    storageRecordDigest: digestOf(`storage:${label}`),
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: createdAt,
    storageRecordSignerCertificateDigest: HOST_SIGNER,
    storageRecordSignature: "c2lnbmF0dXJl",
    createdAt,
  };
}

function seedHost(store: StateStore, createdAt: string): void {
  for (const item of [
    hostArtifact(HOST_SIGNER, "signer", createdAt),
    hostArtifact(HOST_POLICY, "policy", createdAt),
    hostArtifact(HOST_CAPABILITY, "capability", createdAt),
    hostArtifact(HOST_GRANT_POLICY, "grant-policy", createdAt),
  ]) {
    store.putHostAuthorityArtifact(item);
  }
}

function identityRecord(
  cert: IssuedCert,
  principalId: string,
  identityKind: CertificatePrincipalRecord["identityKind"],
  audiences: readonly string[],
  ed25519PublicKey: KeyObject,
  notAfter: string,
): CertificatePrincipalRecord {
  const parsed = parsePeerCertificate(cert.der);
  return {
    principalId,
    identityKind,
    certificateSerial: parsed.serial,
    spkiSha256: parsed.spkiSha256,
    revokedAt: undefined,
    notAfter,
    audiences: [...audiences],
    ed25519PublicKey,
  };
}

export function makeSigner(
  privateKey: KeyObject,
  keyid: string,
  clock: () => string,
  alg: "ed25519" | "ecdsa-p256-sha256" = "ed25519",
): MutationSigner {
  return ({ method, url, headers, body }) => {
    const now = clock();
    const created = Math.floor(Date.parse(now) / 1000);
    const issuedAt = new Date(created * 1000).toISOString();
    const expiresAt = new Date((created + 60) * 1000).toISOString();
    const nonce = generateNonce();
    const fromHeader = headers["operation-id"];
    const operationId =
      fromHeader ?? opId(Number.parseInt(randomBytes(2).toString("hex"), 16) % 0xffff);
    const contentType = headers["content-type"] ?? "application/json";
    const ifMatch = headers["if-match"];
    const mut = mutationHeaders({
      contentType,
      body,
      operationId,
      issuedAt,
      expiresAt,
      nonce,
      ...(ifMatch === undefined ? {} : { ifMatch }),
    });
    const merged = { ...headers, ...mut };
    const signed = signMutation({
      message: {
        method,
        authority: url.host,
        targetUri: `${url.protocol}//${url.host}${url.pathname}${url.search}`,
        headers: merged,
        body,
      },
      privateKey,
      keyid,
      alg,
      created,
      expires: created + 60,
      nonce,
    });
    return {
      headers: {
        ...merged,
        "signature-input": signed.signatureInput,
        signature: signed.signature,
      },
    };
  };
}

export type Harness = {
  pki: TestPki;
  store: StateStore;
  listening: ListeningControlPlane;
  clockMs: { value: number };
  clock: () => string;
  advance: (ms: number) => void;
  admin: ControlPlaneClient;
  broker: ControlPlaneClient;
  runner: ControlPlaneClient;
  worker: ControlPlaneClient;
  unknown: ControlPlaneClient;
  adminPrivateKey: KeyObject;
  close: () => Promise<void>;
};

function bootstrapWorld(
  store: StateStore,
  adminRecord: CertificatePrincipalRecord,
  now: string,
): void {
  const scope = constructPrincipalScope({
    record: adminRecord,
    grants: [
      {
        projectId: PROJECT_ID,
        roles: ["admin"],
        grantObjectDigest: HOST_GRANT_POLICY,
        revokedAt: undefined,
      },
    ],
    authenticatedAt: now,
  });
  store.createUntrustedProject(scope, {
    projectId: PROJECT_ID,
    displayName: PROJECT_ID,
    classification: "internal",
    policy: sqlArtifact(
      digestOf(`policy:${PROJECT_ID}`),
      "ProjectPolicy",
      `policy:${PROJECT_ID}`,
      now,
    ),
    createdAt: now,
  });
  const projectScope = store.toProjectScope(scope, PROJECT_ID);
  const subject = digestOf(`subject:${PROJECT_ID}`);
  const display = digestOf(`display:${PROJECT_ID}`);
  const challenge = digestOf(`challenge:${PROJECT_ID}`);
  const decision = digestOf(`decision:${PROJECT_ID}`);
  const grant = digestOf(`grant-art:${PROJECT_ID}`);
  store.putArtifact(
    projectScope,
    sqlArtifact(subject, "ApprovalSubject", `subject:${PROJECT_ID}`, now),
  );
  store.putArtifact(
    projectScope,
    sqlArtifact(display, "ApprovalChallenge", `display:${PROJECT_ID}`, now),
  );
  store.putArtifact(
    projectScope,
    sqlArtifact(challenge, "ApprovalChallenge", `challenge:${PROJECT_ID}`, now),
  );
  store.putArtifact(
    projectScope,
    sqlArtifact(decision, "ApprovalDecision", `decision:${PROJECT_ID}`, now),
  );
  store.putArtifact(projectScope, sqlArtifact(grant, "ApprovalGrant", `grant:${PROJECT_ID}`, now));
  store.setProjectTrust(scope, {
    projectId: PROJECT_ID,
    nextTrustState: "trusted",
    approvalId: `trust-${PROJECT_ID}`,
    principalId: scope.principalId,
    subjectDigest: subject,
    hostPolicyDigest: HOST_POLICY,
    challengeDigest: challenge,
    decisionDigest: decision,
    grantDigest: grant,
    displayArtifactDigest: display,
    nonceHash: digestOf(`nonce:${PROJECT_ID}`),
    expiresAt: new Date(Date.parse(now) + 3600_000).toISOString(),
    createdAt: now,
    consumedAt: now,
    outcome: "approved",
  });
  store.createRunner(scope, {
    runnerId: RUNNER_ID,
    principalId: "runner-principal",
    platform: "windows",
    capabilityDigest: HOST_CAPABILITY,
    lastSeenAt: now,
  });
  store.grantRunnerProject(projectScope, {
    runnerId: RUNNER_ID,
    capabilityPolicyDigest: HOST_GRANT_POLICY,
    createdAt: now,
  });
  const broker = digestOf(`broker:${PROJECT_ID}`);
  const registration = digestOf(`registration:${PROJECT_ID}`);
  store.putArtifact(projectScope, sqlArtifact(broker, null, `broker:${PROJECT_ID}`, now));
  store.putArtifact(
    projectScope,
    sqlArtifact(registration, "ApprovalGrant", `registration:${PROJECT_ID}`, now),
  );
  store.createWorkspace(projectScope, {
    workspaceId: WORKSPACE_ID,
    runnerId: RUNNER_ID,
    rootFingerprint: `fp-${PROJECT_ID}`,
    platform: "windows",
    brokerAttestationDigest: broker,
    registrationGrantDigest: registration,
    createdAt: now,
  });
  const taskDigest = digestOf(`task:${PROJECT_ID}:${RUN_ID}`);
  store.putArtifact(projectScope, sqlArtifact(taskDigest, "TaskEnvelope", `task:${RUN_ID}`, now));
  store.createRun(projectScope, {
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    taskEnvelopeDigest: taskDigest,
    createdAt: now,
  });
}

export async function startHarness(): Promise<Harness> {
  const pki = generateTestPki();
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hec-cp-"));
  const clockMs = { value: Date.now() };
  const clock = (): string => new Date(clockMs.value).toISOString();
  const advance = (ms: number): void => {
    clockMs.value += ms;
  };
  const now = clock();
  const hostLeaseKey = Buffer.alloc(32, 11);
  const dbResponseKey = Buffer.alloc(32, 12);
  const store = openStateStore({
    dbPath: path.join(dir, "control.sqlite"),
    hostLeaseKey,
    dbResponseKey,
    migrationsDir: defaultControlMigrationsDir(),
    argon2: ARGON2ID_TEST_PARAMETERS,
    appliedAt: now,
  });
  seedHost(store, now);
  const adminSign = generateKeyPairSync("ed25519");
  const brokerSign = generateKeyPairSync("ed25519");
  const runnerSign = generateKeyPairSync("ed25519");
  const workerSign = generateKeyPairSync("ed25519");
  const notAfter = "2049-12-31T23:59:59.000Z";
  const staticIdentity = new StaticIdentityStore({
    records: [
      identityRecord(pki.admin, "admin-1", "admin", ["admin"], adminSign.publicKey, notAfter),
      identityRecord(pki.broker, "broker-1", "broker", ["broker"], brokerSign.publicKey, notAfter),
      identityRecord(
        pki.runner,
        "runner-principal",
        "runner",
        ["runner"],
        runnerSign.publicKey,
        notAfter,
      ),
      identityRecord(pki.worker, "worker-1", "worker", ["worker"], workerSign.publicKey, notAfter),
    ],
    grants: {
      "broker-1": [
        {
          projectId: PROJECT_ID,
          roles: ["broker"],
          grantObjectDigest: HOST_GRANT_POLICY,
          revokedAt: undefined,
        },
      ],
      "runner-principal": [
        {
          projectId: PROJECT_ID,
          roles: ["runner"],
          grantObjectDigest: HOST_GRANT_POLICY,
          revokedAt: undefined,
        },
      ],
      "worker-1": [
        {
          projectId: PROJECT_ID,
          roles: ["worker"],
          grantObjectDigest: HOST_GRANT_POLICY,
          revokedAt: undefined,
        },
      ],
    },
    projects: [{ projectId: PROJECT_ID, grantObjectDigest: HOST_GRANT_POLICY }],
  });
  const adminParsed = parsePeerCertificate(pki.admin.der);
  const adminRecord = staticIdentity.lookupBySerialAndSpki(
    adminParsed.serial,
    adminParsed.spkiSha256,
  );
  if (adminRecord === undefined) {
    throw new Error("admin identity missing");
  }
  bootstrapWorld(store, adminRecord, now);
  const runnerParsed = parsePeerCertificate(pki.runner.der);
  store.insertRunnerCertificate(
    constructPrincipalScope({ record: adminRecord, grants: [], authenticatedAt: now }),
    {
      certificateSerial: runnerParsed.serial,
      runnerId: RUNNER_ID,
      spkiSha256: runnerParsed.spkiSha256,
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter,
      issuedAt: now,
    },
  );
  const sqliteIdentity = new SqliteIdentityStore(store);
  const composite = new CompositeIdentityStore(sqliteIdentity, staticIdentity);
  const listing = new ProjectListingIdentityStore(composite, () =>
    store
      .listProjects(
        constructPrincipalScope({ record: adminRecord, grants: [], authenticatedAt: clock() }),
      )
      .map((project) => ({ projectId: project.projectId, grantObjectDigest: HOST_GRANT_POLICY })),
  );
  const identity = expandOperationalPrincipalGrants(listing, [
    { principalId: "broker-1", identityKind: "broker" },
    { principalId: "runner-principal", identityKind: "runner" },
    { principalId: "worker-1", identityKind: "worker" },
  ]);
  const cas = createFilesystemCas({
    rootDir: path.join(dir, "cas"),
    sink: new MemoryStorageRecordSink(),
    kek: {
      unwrapProjectDek: () => ({
        keyId: "test-dek-1",
        dek: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
      }),
    },
    occupancy: neverOccupied(),
    clock: { nowIso: clock, nowMs: () => clockMs.value },
  });
  const ctx: AppContext = {
    store,
    cas,
    identity,
    nonceCache: new NonceCache(() => clockMs.value),
    clock,
    hostSignerDigest: HOST_SIGNER,
    hostPolicyDigest: HOST_POLICY,
    hostCapabilityDigest: HOST_CAPABILITY,
    hostGrantPolicyDigest: HOST_GRANT_POLICY,
    blobLimit: BLOB_BODY_LIMIT,
    jsonLimit: JSON_BODY_LIMIT,
    leaseWaitMs: 150,
    scheduler: new Scheduler(),
    signingKeys: new Map([
      ["admin-1", adminSign.publicKey],
      ["broker-1", brokerSign.publicKey],
      ["runner-principal", runnerSign.publicKey],
      ["worker-1", workerSign.publicKey],
    ]),
    brokerPrivateKey: brokerSign.privateKey,
    brokerKeyId: "broker-1",
    brokerCertificateObjectDigest: HOST_SIGNER,
    approvalNonces: new ApprovalNonceRegistry(),
    hostAdminRecord: adminRecord,
    hostCaCertPem: pki.ca.certPem,
    hostCaPrivateKey: parseCaPrivateKey(pki.ca.keyPem),
  };
  const listening = await listenControlPlane(ctx, {
    mtlsPort: 0,
    enrollPort: 0,
    host: "127.0.0.1",
    jsonBodyLimit: JSON_BODY_LIMIT,
    blobBodyLimit: BLOB_BODY_LIMIT,
    leaseWaitMs: 150,
    dbPath: path.join(dir, "control.sqlite"),
    casRoot: path.join(dir, "cas"),
    hostLeaseKey,
    dbResponseKey,
    hostDek: Uint8Array.from({ length: 32 }, (_, i) => i + 2),
    tls: { caPem: pki.ca.certPem, certPem: pki.server.certPem, keyPem: pki.server.keyPem },
    hostCaCertPem: pki.ca.certPem,
    hostCaPrivateKeyPem: pki.ca.keyPem,
    hostSignerDigest: HOST_SIGNER,
    hostPolicyDigest: HOST_POLICY,
    hostCapabilityDigest: HOST_CAPABILITY,
    hostGrantPolicyDigest: HOST_GRANT_POLICY,
  });
  const clientOf = (cert: IssuedCert, signer: MutationSigner | undefined): ControlPlaneClient =>
    new ControlPlaneClient({
      baseUrl: listening.mtlsUrl,
      enrollBaseUrl: listening.enrollUrl,
      tls: { ca: pki.ca.certPem, cert: cert.certPem, key: cert.keyPem, servername: "127.0.0.1" },
      enrollTls: { ca: pki.ca.certPem, servername: "127.0.0.1" },
      ...(signer === undefined ? {} : { signer }),
    });
  const admin = clientOf(pki.admin, makeSigner(adminSign.privateKey, "admin-1", clock));
  const broker = clientOf(pki.broker, makeSigner(brokerSign.privateKey, "broker-1", clock));
  const runner = clientOf(pki.runner, makeSigner(runnerSign.privateKey, "runner-principal", clock));
  const worker = clientOf(pki.worker, makeSigner(workerSign.privateKey, "worker-1", clock));
  const unknown = clientOf(pki.unknown, undefined);
  return {
    pki,
    store,
    listening,
    clockMs,
    clock,
    advance,
    admin,
    broker,
    runner,
    worker,
    unknown,
    adminPrivateKey: adminSign.privateKey,
    close: async () => {
      admin.close();
      broker.close();
      runner.close();
      worker.close();
      unknown.close();
      await listening.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function policyEnvelope(projectId: string, trustedInstructionRoots: readonly string[] = []) {
  const payload: ProjectPolicy = {
    schemaVersion: 1,
    projectId,
    classification: "internal",
    trustedInstructionRoots: [...trustedInstructionRoots],
    allowedCloudDeploymentIds: [],
    permittedEgressClassifications: ["internal"],
    standingApprovalPolicyDigests: [],
  };
  return {
    schemaName: "ProjectPolicy",
    schemaVersion: 1,
    payload,
    payloadDigest: payloadDigest({ schemaName: "ProjectPolicy", schemaVersion: 1, payload }),
    signatures: [],
  };
}

export function createProjectBody(projectId: string) {
  return {
    schemaVersion: 1 as const,
    projectId,
    displayName: projectId,
    classification: "internal" as const,
    policy: policyEnvelope(projectId),
  };
}

export function parseJson(body: Buffer): unknown {
  return JSON.parse(body.toString("utf8"));
}
