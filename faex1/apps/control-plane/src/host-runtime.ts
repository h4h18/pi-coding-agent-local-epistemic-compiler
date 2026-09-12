import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  randomPrefixedUuidV7,
  sha256Utf8,
  type HostConfig,
  type ObjectDigest,
} from "@pi-hec/contracts";
import {
  ARGON2ID_PRODUCTION_PARAMETERS,
  defaultControlMigrationsDir,
  openStateStore,
  type StateStore,
} from "@pi-hec/state-store";
import { createFilesystemCas, MemoryStorageRecordSink, neverOccupied } from "@pi-hec/cas";
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
  type IdentityKind,
} from "@pi-hec/security";
import type { MutationSigner } from "@pi-hec/client";
import {
  BLOB_BODY_LIMIT,
  DEFAULT_LEASE_WAIT_MS,
  JSON_BODY_LIMIT,
  signHostConfig,
  type ControlPlaneConfig,
} from "./config.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { ProjectListingIdentityStore, type AppContext } from "./orchestration/handlers.js";
import { Scheduler } from "./orchestration/scheduler.js";
import { generateHostPki, parseCaPrivateKey, type IssuedCert } from "./pki.js";

export const DEFAULT_ETC_DIR = "/etc/pi-hec";
export const DEFAULT_LISTEN_HOST = "10.10.10.184";
export const DEFAULT_MTLS_PORT = 8443;
export const DEFAULT_ENROLL_PORT = 8444;
export const HOST_CONFIG_KEY_ID = "host-cfg-1";

const POLICY_DIGEST = sha256Utf8("faex1-retention-policy") as ObjectDigest;
const BACKUP_DIGEST = sha256Utf8("faex1-backup-policy") as ObjectDigest;

export type HostPrincipalName =
  | "admin"
  | "broker"
  | "runner"
  | "worker"
  | "pi-agent";

export type HostPrincipalSpec = {
  name: HostPrincipalName;
  principalId: string;
  identityKind: IdentityKind;
  audiences: readonly string[];
};

export const HOST_PRINCIPALS: readonly HostPrincipalSpec[] = [
  { name: "admin", principalId: "admin-1", identityKind: "admin", audiences: ["admin"] },
  { name: "broker", principalId: "broker-1", identityKind: "broker", audiences: ["broker"] },
  {
    name: "runner",
    principalId: "runner-principal",
    identityKind: "runner",
    audiences: ["runner"],
  },
  { name: "worker", principalId: "worker-1", identityKind: "worker", audiences: ["worker"] },
  { name: "pi-agent", principalId: "pi-agent-1", identityKind: "service", audiences: ["service"] },
];

export type HostIdentitiesFile = {
  schemaVersion: 1;
  keyId: string;
  listenHost: string;
  mtlsPort: number;
  enrollPort: number;
  signerDigest: ObjectDigest;
  policyDigest: ObjectDigest;
  capabilityDigest: ObjectDigest;
  grantPolicyDigest: ObjectDigest;
  principals: readonly HostPrincipalSpec[];
};

export type HostKeysFile = {
  schemaVersion: 1;
  hostLeaseKeyB64: string;
  dbResponseKeyB64: string;
  hostDekB64: string;
};

function writeRestricted(filePath: string, contents: string | Buffer, mode: number): void {
  writeFileSync(filePath, contents, { mode });
}

function pemPublic(key: KeyObject): string {
  const pem = key.export({ type: "spki", format: "pem" });
  if (typeof pem !== "string") {
    throw new Error("expected pem public key");
  }
  return pem;
}

function pemPrivate(key: KeyObject): string {
  const pem = key.export({ type: "pkcs8", format: "pem" });
  if (typeof pem !== "string") {
    throw new Error("expected pem private key");
  }
  return pem;
}

function parseIpv4(host: string): readonly [number, number, number, number] {
  const parts = host.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    throw new Error(`listen host ${host} is not an ipv4 address`);
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

function certFor(name: HostPrincipalName, pki: ReturnType<typeof generateHostPki>): IssuedCert {
  switch (name) {
    case "admin":
      return pki.admin;
    case "broker":
      return pki.broker;
    case "runner":
      return pki.runner;
    case "worker":
      return pki.worker;
    case "pi-agent":
      return pki.piAgent;
    default: {
      const exhaustive: never = name;
      throw new Error(`unhandled principal ${String(exhaustive)}`);
    }
  }
}

export function faex1HostConfig(input: {
  listenHost: string;
  mtlsPort: number;
  databasePath: string;
  casRoot: string;
  indexRoot: string;
}): HostConfig {
  return {
    schemaVersion: 1,
    configRevision: 1,
    deploymentSecurityProfile: "SINGLE_HOST",
    control: {
      listenAddress: `${input.listenHost}:${String(input.mtlsPort)}`,
      databasePath: input.databasePath,
      casRoot: input.casRoot,
      indexRoot: input.indexRoot,
      tlsIdentityRef: "tls-control",
      trustedClientCaRef: "ca-clients",
    },
    independentServices: {},
    localDeployments: [
      {
        deploymentId: "qwen3.8-27b",
        endpoint: "http://127.0.0.1:8000/v1",
        modelRevision: "sha256:a830e736efa71ce29589ff20b8713333a427e0d46ab774723be23800ad54362d",
        profile: "qwen3.8-27b-llamacpp-vulkan-linux",
      },
    ],
    cloudDeployments: [],
    safetyProfiles: [
      {
        id: "default",
        cpuMillis: 120_000,
        memoryBytes: 8_589_934_592,
        processCount: 32,
        diskBytes: 34_359_738_368,
        wallClockMillis: 600_000,
        stdoutBytes: 8_388_608,
        stderrBytes: 8_388_608,
      },
    ],
    retentionPolicyObjectDigest: POLICY_DIGEST,
    backupPolicyObjectDigest: BACKUP_DIGEST,
  };
}

export function writeHostRuntimeFiles(input: {
  etcDir: string;
  listenHost: string;
  mtlsPort: number;
  enrollPort: number;
  databasePath: string;
  casRoot: string;
  indexRoot: string;
}): HostIdentitiesFile {
  mkdirSync(path.join(input.etcDir, "pki"), { recursive: true, mode: 0o700 });
  const pki = generateHostPki({
    caSubject: "pi-hec-faex1-ca",
    ipv4Sans: [[127, 0, 0, 1], parseIpv4(input.listenHost)],
    dnsNames: ["localhost", "faex1"],
  });
  const hostSign = generateKeyPairSync("ed25519");
  writeRestricted(path.join(input.etcDir, "pki", "ca.crt.pem"), pki.ca.certPem, 0o644);
  writeRestricted(path.join(input.etcDir, "pki", "ca.key.pem"), pki.ca.keyPem, 0o600);
  writeRestricted(path.join(input.etcDir, "pki", "server.crt.pem"), pki.server.certPem, 0o644);
  writeRestricted(path.join(input.etcDir, "pki", "server.key.pem"), pki.server.keyPem, 0o600);
  writeRestricted(path.join(input.etcDir, "host-config.key.pem"), pemPrivate(hostSign.privateKey), 0o600);
  writeRestricted(path.join(input.etcDir, "host-config.pub.pem"), pemPublic(hostSign.publicKey), 0o644);
  for (const principal of HOST_PRINCIPALS) {
    const cert = certFor(principal.name, pki);
    const sign = generateKeyPairSync("ed25519");
    writeRestricted(path.join(input.etcDir, "pki", `${principal.name}.crt.pem`), cert.certPem, 0o644);
    writeRestricted(path.join(input.etcDir, "pki", `${principal.name}.key.pem`), cert.keyPem, 0o600);
    writeRestricted(
      path.join(input.etcDir, "pki", `${principal.name}.sign.key.pem`),
      pemPrivate(sign.privateKey),
      0o600,
    );
    writeRestricted(
      path.join(input.etcDir, "pki", `${principal.name}.sign.pub.pem`),
      pemPublic(sign.publicKey),
      0o644,
    );
  }
  const keys: HostKeysFile = {
    schemaVersion: 1,
    hostLeaseKeyB64: Buffer.from(randomBytes(32)).toString("base64"),
    dbResponseKeyB64: Buffer.from(randomBytes(32)).toString("base64"),
    hostDekB64: Buffer.from(randomBytes(32)).toString("base64"),
  };
  writeRestricted(path.join(input.etcDir, "keys.json"), `${JSON.stringify(keys, null, 2)}\n`, 0o600);
  const identities: HostIdentitiesFile = {
    schemaVersion: 1,
    keyId: HOST_CONFIG_KEY_ID,
    listenHost: input.listenHost,
    mtlsPort: input.mtlsPort,
    enrollPort: input.enrollPort,
    signerDigest: sha256Utf8("faex1-host-signer-cert") as ObjectDigest,
    policyDigest: sha256Utf8("faex1-host-policy") as ObjectDigest,
    capabilityDigest: sha256Utf8("faex1-host-runner-capability") as ObjectDigest,
    grantPolicyDigest: sha256Utf8("faex1-host-runner-grant-policy") as ObjectDigest,
    principals: HOST_PRINCIPALS,
  };
  writeRestricted(
    path.join(input.etcDir, "identities.json"),
    `${JSON.stringify(identities, null, 2)}\n`,
    0o640,
  );
  const signed = signHostConfig(
    faex1HostConfig({
      listenHost: input.listenHost,
      mtlsPort: input.mtlsPort,
      databasePath: input.databasePath,
      casRoot: input.casRoot,
      indexRoot: input.indexRoot,
    }),
    hostSign.privateKey,
    HOST_CONFIG_KEY_ID,
  );
  writeRestricted(
    path.join(input.etcDir, "host-config.json"),
    `${JSON.stringify(signed, null, 2)}\n`,
    0o600,
  );
  return identities;
}

function loadPemKey(filePath: string): KeyObject {
  return createPrivateKey(readFileSync(filePath, "utf8"));
}

function hostArtifact(
  objectDigest: ObjectDigest,
  label: string,
  createdAt: string,
) {
  return {
    objectDigest,
    schemaName: "HostAuthority",
    mediaType: "application/json",
    byteSize: 32,
    encryptionKeyId: `host-key:${label}`,
    encryptionNonce: label.padEnd(24, "0").slice(0, 24),
    signatureKeyId: "host-sign",
    signature: "c2ln",
    createdAt,
  };
}

export function createMutationSigner(privateKey: KeyObject, keyid: string): MutationSigner {
  return ({ method, url, headers, body }) => {
    const now = new Date();
    const created = Math.floor(now.getTime() / 1000);
    const issuedAt = new Date(created * 1000).toISOString();
    const expiresAt = new Date((created + 60) * 1000).toISOString();
    const nonce = generateNonce();
    const fromHeader = headers["operation-id"];
    const operationId = fromHeader ?? randomPrefixedUuidV7("op_");
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
      alg: "ed25519",
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

export type LoadedHostRuntime = {
  identities: HostIdentitiesFile;
  keys: HostKeysFile;
  store: StateStore;
  ctx: AppContext;
  controlConfig: ControlPlaneConfig;
};

export function loadHostRuntime(etcDir: string = DEFAULT_ETC_DIR): LoadedHostRuntime {
  const identities = JSON.parse(
    readFileSync(path.join(etcDir, "identities.json"), "utf8"),
  ) as HostIdentitiesFile;
  const keys = JSON.parse(readFileSync(path.join(etcDir, "keys.json"), "utf8")) as HostKeysFile;
  const hostLeaseKey = Buffer.from(keys.hostLeaseKeyB64, "base64");
  const dbResponseKey = Buffer.from(keys.dbResponseKeyB64, "base64");
  const hostDek = Buffer.from(keys.hostDekB64, "base64");
  if (hostLeaseKey.byteLength !== 32 || dbResponseKey.byteLength !== 32 || hostDek.byteLength !== 32) {
    throw new Error("host keys must be 32 bytes");
  }
  const signedHost = JSON.parse(readFileSync(path.join(etcDir, "host-config.json"), "utf8")) as {
    config: HostConfig;
  };
  const now = new Date().toISOString();
  const store = openStateStore({
    dbPath: signedHost.config.control.databasePath,
    hostLeaseKey,
    dbResponseKey,
    migrationsDir: defaultControlMigrationsDir(),
    argon2: ARGON2ID_PRODUCTION_PARAMETERS,
    appliedAt: now,
  });
  for (const item of [
    hostArtifact(identities.signerDigest, "signer", now),
    hostArtifact(identities.policyDigest, "policy", now),
    hostArtifact(identities.capabilityDigest, "capability", now),
    hostArtifact(identities.grantPolicyDigest, "grant-policy", now),
  ]) {
    try {
      store.putHostAuthorityArtifact(item);
    } catch {
      // already seeded on restart
    }
  }
  const records: CertificatePrincipalRecord[] = [];
  const signingKeys = new Map<string, KeyObject>();
  let adminRecord: CertificatePrincipalRecord | undefined;
  let brokerPrivateKey: KeyObject | undefined;
  for (const principal of identities.principals) {
    const certPem = readFileSync(path.join(etcDir, "pki", `${principal.name}.crt.pem`), "utf8");
    const x509 = new X509Certificate(certPem);
    const parsed = parsePeerCertificate(Buffer.from(x509.raw));
    const signPrivate = loadPemKey(path.join(etcDir, "pki", `${principal.name}.sign.key.pem`));
    const signPublic = createPublicKey(signPrivate);
    const record: CertificatePrincipalRecord = {
      principalId: principal.principalId,
      identityKind: principal.identityKind,
      certificateSerial: parsed.serial,
      spkiSha256: parsed.spkiSha256,
      revokedAt: undefined,
      notAfter: parsed.notAfter,
      audiences: [...principal.audiences],
      ed25519PublicKey: signPublic,
    };
    records.push(record);
    signingKeys.set(principal.principalId, signPublic);
    if (principal.name === "admin") {
      adminRecord = record;
    }
    if (principal.name === "broker") {
      brokerPrivateKey = signPrivate;
    }
  }
  if (adminRecord === undefined || brokerPrivateKey === undefined) {
    throw new Error("admin or broker identity missing");
  }
  const grants: Record<string, { projectId: string; roles: readonly string[]; grantObjectDigest: ObjectDigest; revokedAt: undefined }[]> =
    {};
  const staticIdentity = new StaticIdentityStore({
    records,
    grants,
    projects: [],
  });
  const sqliteIdentity = new SqliteIdentityStore(store);
  const composite = new CompositeIdentityStore(sqliteIdentity, staticIdentity);
  const listing = new ProjectListingIdentityStore(composite, () =>
    store
      .listProjects(
        constructPrincipalScope({
          record: adminRecord,
          grants: [],
          authenticatedAt: new Date().toISOString(),
        }),
      )
      .map((project) => ({
        projectId: project.projectId,
        grantObjectDigest: identities.grantPolicyDigest,
      })),
  );
  const workerGrantStore = {
    lookupBySerialAndSpki: listing.lookupBySerialAndSpki.bind(listing),
    listAllProjects: listing.listAllProjects.bind(listing),
    listGrants(principalId: string) {
      const record = records.find((item) => item.principalId === principalId);
      if (record?.identityKind === "worker" || record?.identityKind === "broker") {
        const role = record.identityKind;
        return listing.listAllProjects().map((project) => ({
          projectId: project.projectId,
          roles: [role],
          grantObjectDigest: project.grantObjectDigest,
          revokedAt: undefined,
        }));
      }
      return listing.listGrants(principalId);
    },
  };
  const cas = createFilesystemCas({
    rootDir: signedHost.config.control.casRoot,
    sink: new MemoryStorageRecordSink(),
    kek: {
      unwrapProjectDek: () => ({
        keyId: "host-dek-1",
        dek: hostDek,
      }),
    },
    occupancy: neverOccupied(),
    clock: {
      nowIso: () => new Date().toISOString(),
      nowMs: () => Date.now(),
    },
  });
  const ctx: AppContext = {
    store,
    cas,
    identity: workerGrantStore,
    nonceCache: new NonceCache(() => Date.now()),
    clock: () => new Date().toISOString(),
    hostSignerDigest: identities.signerDigest,
    hostPolicyDigest: identities.policyDigest,
    hostCapabilityDigest: identities.capabilityDigest,
    hostGrantPolicyDigest: identities.grantPolicyDigest,
    blobLimit: BLOB_BODY_LIMIT,
    jsonLimit: JSON_BODY_LIMIT,
    leaseWaitMs: DEFAULT_LEASE_WAIT_MS,
    scheduler: new Scheduler(),
    signingKeys,
    brokerPrivateKey,
    brokerKeyId: "broker-1",
    brokerCertificateObjectDigest: identities.signerDigest,
    approvalNonces: new ApprovalNonceRegistry(),
    hostAdminRecord: adminRecord,
    hostCaCertPem: readFileSync(path.join(etcDir, "pki", "ca.crt.pem"), "utf8"),
    hostCaPrivateKey: parseCaPrivateKey(readFileSync(path.join(etcDir, "pki", "ca.key.pem"), "utf8")),
  };
  const controlConfig: ControlPlaneConfig = {
    mtlsPort: identities.mtlsPort,
    enrollPort: identities.enrollPort,
    host: identities.listenHost,
    jsonBodyLimit: JSON_BODY_LIMIT,
    blobBodyLimit: BLOB_BODY_LIMIT,
    leaseWaitMs: DEFAULT_LEASE_WAIT_MS,
    dbPath: signedHost.config.control.databasePath,
    casRoot: signedHost.config.control.casRoot,
    hostLeaseKey,
    dbResponseKey,
    hostDek,
    tls: {
      caPem: readFileSync(path.join(etcDir, "pki", "ca.crt.pem"), "utf8"),
      certPem: readFileSync(path.join(etcDir, "pki", "server.crt.pem"), "utf8"),
      keyPem: readFileSync(path.join(etcDir, "pki", "server.key.pem"), "utf8"),
    },
    hostCaCertPem: readFileSync(path.join(etcDir, "pki", "ca.crt.pem"), "utf8"),
    hostCaPrivateKeyPem: readFileSync(path.join(etcDir, "pki", "ca.key.pem"), "utf8"),
    hostSignerDigest: identities.signerDigest,
    hostPolicyDigest: identities.policyDigest,
    hostCapabilityDigest: identities.capabilityDigest,
    hostGrantPolicyDigest: identities.grantPolicyDigest,
  };
  return { identities, keys, store, ctx, controlConfig };
}
