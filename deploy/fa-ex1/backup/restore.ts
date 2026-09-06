import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { authenticatedScopeBrand, canonicalizeRfc8785, sha256Utf8, type PrincipalScope } from "@pi-hec/contracts";
import {
  ARGON2ID_TEST_PARAMETERS,
  defaultControlMigrationsDir,
  openStateStore,
  READ_ONLY_RECOVERY_MARKER,
  readOnlyRecoveryMarkerPath,
  type StateStore,
} from "@pi-hec/state-store";
import { issueLeafCertificate, issueSelfSignedCa } from "../../../apps/control-plane/src/pki.js";
import { type BackupUnit, unwrapDek, wrapDek } from "./procedure.js";

export type RestoreCeremonyInput = {
  destinationDir: string;
  hostLeaseKey: Uint8Array;
  dbResponseKey: Uint8Array;
  recoveryPrivateKey?: KeyObject;
};

export type EnrolledIdentity = {
  runnerId: string;
  certificateSerial: string;
  spkiSha256: string;
};

export type RestoredWritable = {
  store: StateStore;
  restoreEpoch: string;
  enrolledIdentities: {
    admin: EnrolledIdentity;
    broker: EnrolledIdentity;
    runner: EnrolledIdentity;
  };
  close: () => void;
};

export function completeRestoreCeremony(input: RestoreCeremonyInput): RestoredWritable {
  const recoveryPrivateKey = input.recoveryPrivateKey;
  if (recoveryPrivateKey === undefined) {
    throw new Error("recovery is irreversible without key material");
  }
  const dbPath = path.join(input.destinationDir, "control.sqlite");
  const unitPath = path.join(input.destinationDir, "unit.json");
  const unit = JSON.parse(readFileSync(unitPath, "utf8")) as BackupUnit;
  const firstWrap = unit.dekWraps[0];
  if (firstWrap !== undefined) {
    unwrapDek(firstWrap.recovery, recoveryPrivateKey);
  }
  for (const object of unit.reachable) {
    const bytes = Buffer.from(object.bytesBase64, "base64");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== object.digest) {
      throw new Error(`restored object digest mismatch for ${object.digest}`);
    }
  }
  const online = generateKeyPairSync("x25519");
  const rewrapped = unit.dekWraps.map((wrap) => {
    const dek = unwrapDek(wrap.recovery, recoveryPrivateKey);
    return {
      ...wrap,
      online: wrapDek(dek, online.publicKey),
      recovery: wrapDek(dek, createPublicKey(recoveryPrivateKey)),
    };
  });
  const restoreEpoch = `restore-${createHash("sha256")
    .update(`${unit.epoch}:${String(Date.now())}`)
    .digest("hex")
    .slice(0, 16)}`;
  const marker = readOnlyRecoveryMarkerPath(dbPath);
  if (existsSync(marker)) {
    unlinkSync(marker);
  }
  writeFileSync(path.join(input.destinationDir, `${READ_ONLY_RECOVERY_MARKER}.cleared`), restoreEpoch, "utf8");
  const store = openStateStore({
    dbPath,
    hostLeaseKey: input.hostLeaseKey,
    dbResponseKey: input.dbResponseKey,
    migrationsDir: defaultControlMigrationsDir(),
    argon2: ARGON2ID_TEST_PARAMETERS,
  });
  const enrolledIdentities = enrollRestoredIdentities(store, restoreEpoch);
  const enrolled = {
    schemaVersion: 1 as const,
    restoreEpoch,
    identities: enrolledIdentities,
    dekWraps: rewrapped,
  };
  const broker = generateKeyPairSync("ed25519");
  const canonical = canonicalizeRfc8785({
    schemaVersion: 1,
    restoreEpoch,
    broker: enrolledIdentities.broker.certificateSerial,
  });
  const signed = {
    ...enrolled,
    signature: cryptoSign(null, Buffer.from(canonical, "utf8"), broker.privateKey).toString("base64"),
  };
  writeFileSync(path.join(input.destinationDir, "restore-epoch.json"), `${JSON.stringify(signed)}\n`);
  writeFileSync(unitPath, JSON.stringify({ ...unit, dekWraps: rewrapped }));
  return {
    store,
    restoreEpoch,
    enrolledIdentities,
    close: () => {
      store.close();
    },
  };
}

function enrollRestoredIdentities(
  store: StateStore,
  restoreEpoch: string,
): RestoredWritable["enrolledIdentities"] {
  const ca = issueSelfSignedCa(`pi-hec-restore-${restoreEpoch}`);
  const now = "2026-08-29T00:00:00.000Z";
  const notBefore = new Date(Date.UTC(2026, 0, 1));
  const notAfter = new Date(Date.UTC(2049, 11, 31));
  const scope: PrincipalScope = {
    [authenticatedScopeBrand]: true,
    principalId: "admin-1",
    identityKind: "admin",
    certificateSerial: "serial-admin",
    audiences: ["control"],
    projectGrants: [],
    authenticatedAt: now,
  };
  const capability = sha256Utf8("host-runner-capability");
  const enrolled = {
    admin: enrollOne(store, scope, ca, "admin-restored", "admin-restored-principal", capability, notBefore, notAfter, now),
    broker: enrollOne(store, scope, ca, "broker-restored", "broker-restored-principal", capability, notBefore, notAfter, now),
    runner: enrollOne(store, scope, ca, "runner-restored", "runner-restored-principal", capability, notBefore, notAfter, now),
  };
  return enrolled;
}

function enrollOne(
  store: StateStore,
  scope: Parameters<StateStore["createRunner"]>[0],
  ca: ReturnType<typeof issueSelfSignedCa>,
  runnerId: string,
  principalId: string,
  capabilityDigest: string,
  notBefore: Date,
  notAfter: Date,
  now: string,
): EnrolledIdentity {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const leaf = issueLeafCertificate({
    caCertPem: ca.certPem,
    caPrivateKey: ca.privateKey,
    spkiDer: Buffer.from(pair.publicKey.export({ type: "spki", format: "der" })),
    subject: runnerId,
    notBefore,
    notAfter,
  });
  store.createRunner(scope, {
    runnerId,
    principalId,
    platform: "linux",
    capabilityDigest,
    lastSeenAt: now,
  });
  store.insertRunnerCertificate(scope, {
    certificateSerial: leaf.serial,
    runnerId,
    spkiSha256: leaf.spkiSha256,
    notBefore: leaf.notBefore,
    notAfter: leaf.notAfter,
    issuedAt: now,
  });
  return {
    runnerId,
    certificateSerial: leaf.serial,
    spkiSha256: leaf.spkiSha256,
  };
}
