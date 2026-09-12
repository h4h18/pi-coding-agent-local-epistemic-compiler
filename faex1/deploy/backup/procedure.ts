import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  createCasLayout,
  createFilesystemCas,
  listStoredHex,
  MemoryStorageRecordSink,
  type KekHook,
} from "@pi-hec/cas";
import type { ObjectDigest } from "@pi-hec/contracts";
import {
  ARGON2ID_TEST_PARAMETERS,
  defaultControlMigrationsDir,
  openStateStore,
  READ_ONLY_RECOVERY_MARKER,
  readOnlyRecoveryMarkerPath,
  type StateStore,
} from "@pi-hec/state-store";
import {
  defaultHostSecretDir,
  loadOrCreateOnlineWrap,
  loadOrCreateResticMaster,
} from "./host-secrets.js";
import { chmodOwnerOnly, writeOwnerOnlyFile } from "./owner-mode.js";
import {
  RESTIC_VERSION,
  initResticRepo,
  putResticBlob,
  readResticBlob,
  verifyResticRepo,
  type ResticMasterKey,
} from "./restic-aead.js";

export const CANARY_CREDENTIAL = "CANARY_CREDENTIAL_pi-hec-task25-do-not-export";
export { READ_ONLY_RECOVERY_MARKER, readOnlyRecoveryMarkerPath };

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as new (filename: string) => {
  pragma: (source: string, options?: { simple?: boolean }) => unknown;
  close: () => void;
};

export type BackupLookup = {
  status: 404;
  body: { error: "NOT_FOUND" };
};

export type ReachableObject = {
  projectId: string;
  digest: ObjectDigest;
  bytes: Uint8Array;
};

export type PerformBackupInput = {
  store: StateStore;
  dbPath: string;
  casRoot: string;
  reachableDigests: readonly ObjectDigest[];
  reachableObjects?: readonly ReachableObject[];
  kek?: KekHook;
  projectIds?: readonly string[];
  appManifests: unknown;
  publicCerts: unknown;
  livePrivateKeyPaths: readonly string[];
  canaryCredential: string;
  backupRoot: string;
  recoveryPublicKey: KeyObject;
  hostSecretDir?: string;
};

export type ProjectDekWrap = {
  projectId: string;
  keyId: string;
  online: string;
  recovery: string;
};

export type BackupResult = {
  epoch: string;
  quickCheck: string;
  repositoryPath: string;
  secondCopyPath: string;
  resticVersion: typeof RESTIC_VERSION;
  resticMaster: ResticMasterKey;
  dekWraps: readonly ProjectDekWrap[];
  lookup: (input: { projectId: string; objectDigest: ObjectDigest }) => BackupLookup;
};

export type RestoreReadOnlyInput = {
  repositoryPath: string;
  destinationDir: string;
  hostLeaseKey: Uint8Array;
  dbResponseKey: Uint8Array;
  masterKey?: ResticMasterKey;
};

export type RestoredReadOnly = {
  store: StateStore;
  close: () => void;
  casObjectPath: (projectId: string, digest: ObjectDigest) => string;
};

type SerializedReachable = {
  projectId: string;
  digest: ObjectDigest;
  bytesBase64: string;
};

export type BackupUnit = {
  epoch: string;
  sqliteName: string;
  reachable: SerializedReachable[];
  appManifests: unknown;
  publicCerts: unknown;
  keyMetadata: { algorithm: "Ed25519"; exportedPrivateKeys: false };
  dekWraps: ProjectDekWrap[];
  recoveryPromise: "irreversible-without-key-material";
};

const NOT_FOUND: BackupLookup = { status: 404, body: { error: "NOT_FOUND" } };

export async function performBackup(input: PerformBackupInput): Promise<BackupResult> {
  const epoch = `epoch-${randomBytes(8).toString("hex")}`;
  const work = path.join(input.backupRoot, epoch);
  mkdirSync(work, { recursive: true });
  const sqliteDest = path.join(work, "control.sqlite");
  await input.store.backup(sqliteDest);
  chmodOwnerOnly(sqliteDest);
  const quickCheck = sqliteQuickCheck(sqliteDest);
  if (quickCheck !== "ok") {
    throw new Error(`sqlite quick_check failed: ${quickCheck}`);
  }

  const reachable = serializeReachable(await enumerateReachable(input));
  const dekWraps = await wrapProjectDeks(input);
  const unit: BackupUnit = {
    epoch,
    sqliteName: "control.sqlite",
    reachable,
    appManifests: input.appManifests,
    publicCerts: input.publicCerts,
    keyMetadata: { algorithm: "Ed25519", exportedPrivateKeys: false },
    dekWraps,
    recoveryPromise: "irreversible-without-key-material",
  };
  const unitJson = JSON.stringify(unit);
  assertCanaryAbsent(unitJson, input.canaryCredential);
  refuseLivePrivateExport(input.livePrivateKeyPaths, unitJson);

  const secretDir = input.hostSecretDir ?? defaultHostSecretDir(input.backupRoot);
  const master = loadOrCreateResticMaster(secretDir);
  const repositoryPath = path.join(input.backupRoot, "restic-repo");
  const configPath = path.join(repositoryPath, "config");
  if (existsSync(configPath)) {
    verifyResticRepo(repositoryPath, master);
  } else {
    initResticRepo(repositoryPath, master);
  }
  const sqliteBytes = readFileSync(sqliteDest);
  refuseLivePrivateExport(input.livePrivateKeyPaths, sqliteBytes.toString("utf8"));
  const dataId = putResticBlob(repositoryPath, master, "data", sqliteBytes);
  const snapshot = Buffer.from(
    JSON.stringify({
      restic: RESTIC_VERSION,
      epoch,
      dataId,
      unit,
    }),
    "utf8",
  );
  const snapId = putResticBlob(repositoryPath, master, "snapshots", snapshot);
  putResticBlob(
    repositoryPath,
    master,
    "index",
    Buffer.from(JSON.stringify({ snapId, dataId }), "utf8"),
  );
  verifyResticRepo(repositoryPath, master);

  const secondCopyPath = path.join(input.backupRoot, "offsite-copy");
  cpSync(repositoryPath, secondCopyPath, { recursive: true });
  chmodTreeOwnerOnly(secondCopyPath);
  verifyResticRepo(secondCopyPath, master);

  assertCanaryAbsent(sqliteBytes.toString("utf8"), input.canaryCredential);
  assertCanaryAbsent(unitJson, input.canaryCredential);

  return {
    epoch,
    quickCheck,
    repositoryPath,
    secondCopyPath,
    resticVersion: RESTIC_VERSION,
    resticMaster: master,
    dekWraps,
    lookup: () => NOT_FOUND,
  };
}

export function restoreReadOnly(input: RestoreReadOnlyInput): RestoredReadOnly {
  if (input.masterKey === undefined) {
    throw new Error("restic master key material is required; recovery is irreversible without it");
  }
  const master = input.masterKey;
  verifyResticRepo(input.repositoryPath, master);
  const snapName = latestSnapshotName(path.join(input.repositoryPath, "snapshots"));
  const snapshot = JSON.parse(
    readResticBlob(input.repositoryPath, master, "snapshots", snapName).toString("utf8"),
  ) as {
    dataId: string;
    unit: BackupUnit;
  };
  mkdirSync(input.destinationDir, { recursive: true });
  const dbPath = path.join(input.destinationDir, "control.sqlite");
  writeOwnerOnlyFile(dbPath, readResticBlob(input.repositoryPath, master, "data", snapshot.dataId));
  writeOwnerOnlyFile(readOnlyRecoveryMarkerPath(dbPath), `${READ_ONLY_RECOVERY_MARKER}\n`);
  writeOwnerOnlyFile(path.join(input.destinationDir, "unit.json"), JSON.stringify(snapshot.unit));
  const casRoot = path.join(input.destinationDir, "cas");
  for (const object of snapshot.unit.reachable) {
    const dest = casPlainPath(casRoot, object.projectId, object.digest);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(object.bytesBase64, "base64"));
  }
  const store = openStateStore({
    dbPath,
    hostLeaseKey: input.hostLeaseKey,
    dbResponseKey: input.dbResponseKey,
    migrationsDir: defaultControlMigrationsDir(),
    argon2: ARGON2ID_TEST_PARAMETERS,
    readOnlyRecovery: true,
  });
  return {
    store,
    close: () => {
      store.close();
    },
    casObjectPath: (projectId, digest) => casPlainPath(casRoot, projectId, digest),
  };
}

export function sqliteQuickCheck(filePath: string): string {
  const db = new Database(filePath);
  try {
    return String(db.pragma("quick_check", { simple: true })).toLowerCase();
  } finally {
    db.close();
  }
}

export function sqliteIntegrityCheck(filePath: string): string {
  const db = new Database(filePath);
  try {
    return String(db.pragma("integrity_check", { simple: true })).toLowerCase();
  } finally {
    db.close();
  }
}

export function wrapDek(dek: Buffer, publicKey: KeyObject): string {
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey });
  const wrapKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "pi-hec-dek-wrap", 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    ephSpki: ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

export function unwrapDek(wrapped: string, privateKey: KeyObject): Buffer {
  const parsed = JSON.parse(wrapped) as {
    ephSpki: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };
  const publicKey = createPublicKey({
    key: Buffer.from(parsed.ephSpki, "base64"),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey, publicKey });
  const wrapKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "pi-hec-dek-wrap", 32));
  const decipher = createDecipheriv("aes-256-gcm", wrapKey, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);
}

export function loadMasterKey(filePath: string): ResticMasterKey {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
    encrypt: string;
    macK: string;
    macR: string;
  };
  return {
    encrypt: Buffer.from(parsed.encrypt, "base64"),
    macK: Buffer.from(parsed.macK, "base64"),
    macR: Buffer.from(parsed.macR, "base64"),
  };
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function enumerateReachable(input: PerformBackupInput): Promise<ReachableObject[]> {
  const collected = new Map<string, ReachableObject>();
  for (const extra of input.reachableObjects ?? []) {
    collected.set(`${extra.projectId}:${extra.digest}`, extra);
  }
  const layout = createCasLayout(input.casRoot);
  const projectIds = input.projectIds ?? listCasProjectIds(input.casRoot);
  const wanted = new Set(input.reachableDigests);
  const cas =
    input.kek === undefined
      ? undefined
      : createFilesystemCas({
          rootDir: input.casRoot,
          sink: new MemoryStorageRecordSink(),
          kek: input.kek,
        });
  for (const projectId of projectIds) {
    const hexes = await listStoredHex(layout, projectId);
    for (const hex of hexes) {
      const digest = `sha256:${hex}` as ObjectDigest;
      if (wanted.size > 0 && !wanted.has(digest)) {
        continue;
      }
      const bytes =
        cas === undefined
          ? readFileSync(layout.objectPath(projectId, hex))
          : Buffer.from(await cas.getObject({ projectId, objectDigest: digest }));
      collected.set(`${projectId}:${digest}`, { projectId, digest, bytes });
    }
  }
  return [...collected.values()];
}

async function wrapProjectDeks(input: PerformBackupInput): Promise<ProjectDekWrap[]> {
  if (input.kek === undefined) {
    return [];
  }
  const secretDir = input.hostSecretDir ?? defaultHostSecretDir(input.backupRoot);
  const online = loadOrCreateOnlineWrap(secretDir);
  const projectIds = input.projectIds ?? listCasProjectIds(input.casRoot);
  const wraps: ProjectDekWrap[] = [];
  for (const projectId of projectIds) {
    const unwrapped = await Promise.resolve(input.kek.unwrapProjectDek({ projectId }));
    const dek = Buffer.from(unwrapped.dek);
    wraps.push({
      projectId,
      keyId: unwrapped.keyId,
      online: wrapDek(dek, online.publicKey),
      recovery: wrapDek(dek, input.recoveryPublicKey),
    });
  }
  return wraps;
}

export function readLatestBackupUnit(repositoryPath: string, master: ResticMasterKey): BackupUnit {
  const snapName = latestSnapshotName(path.join(repositoryPath, "snapshots"));
  const snapshot = JSON.parse(
    readResticBlob(repositoryPath, master, "snapshots", snapName).toString("utf8"),
  ) as {
    unit: BackupUnit;
  };
  return snapshot.unit;
}

export function listCasProjectIds(casRoot: string): string[] {
  const root = path.join(casRoot, "projects");
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function refuseLivePrivateExport(livePrivateKeyPaths: readonly string[], haystack: string): void {
  for (const live of livePrivateKeyPaths) {
    if (!existsSync(live)) {
      continue;
    }
    const material = readFileSync(live, "utf8");
    if (material.length > 0 && haystack.includes(material)) {
      throw new Error("live private key export refused");
    }
  }
}

function serializeReachable(items: readonly ReachableObject[]): SerializedReachable[] {
  return items.map((item) => ({
    projectId: item.projectId,
    digest: item.digest,
    bytesBase64: Buffer.from(item.bytes).toString("base64"),
  }));
}

function casPlainPath(casRoot: string, projectId: string, digest: ObjectDigest): string {
  const hex = digest.slice("sha256:".length);
  return path.join(casRoot, "projects", projectId, "sha256", hex.slice(0, 2), hex.slice(2, 4), hex);
}

function latestSnapshotName(dir: string): string {
  const names = readdirSync(dir);
  const first = names[0];
  if (first === undefined) {
    throw new Error("restic snapshot missing");
  }
  let latest = first;
  let latestMtime = 0;
  for (const name of names) {
    const stamp = statSync(path.join(dir, name)).mtimeMs;
    if (stamp >= latestMtime) {
      latest = name;
      latestMtime = stamp;
    }
  }
  return latest;
}

function chmodTreeOwnerOnly(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    const info = statSync(current);
    if (info.isDirectory()) {
      for (const entry of readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    chmodOwnerOnly(current);
  }
}

function assertCanaryAbsent(haystack: string, canary: string): void {
  if (haystack.includes(canary)) {
    throw new Error("canary credential leaked into backup payload");
  }
}
