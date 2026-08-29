import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { KekHook } from "@pi-hec/cas";
import { authenticatedScopeBrand, type PrincipalScope } from "@pi-hec/contracts";
import type { StateStore } from "@pi-hec/state-store";
import { writeOwnerOnlyFile } from "./owner-mode.js";
import { createMasterKey, type ResticMasterKey } from "./restic-aead.js";

export const ONLINE_WRAP_FILE = "online-wrap.pkcs8";
export const RESTIC_MASTER_FILE = "restic-master.json";
export const RESTIC_ENV_FILE = "restic.env";

export type OnlineWrapKey = {
  privateKey: KeyObject;
  publicKey: KeyObject;
};

export function defaultHostSecretDir(backupRoot: string): string {
  return path.join(path.dirname(backupRoot), ".pi-hec-host-secrets");
}

export function loadOrCreateOnlineWrap(secretDir: string): OnlineWrapKey {
  mkdirSync(secretDir, { recursive: true });
  const keyPath = path.join(secretDir, ONLINE_WRAP_FILE);
  if (existsSync(keyPath)) {
    const privateKey = createPrivateKey({
      key: readFileSync(keyPath),
      format: "der",
      type: "pkcs8",
    });
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  const pair = generateKeyPairSync("x25519");
  writeOwnerOnlyFile(keyPath, pair.privateKey.export({ type: "pkcs8", format: "der" }));
  writeResticEnvPaths(secretDir);
  return pair;
}

export function loadOrCreateResticMaster(secretDir: string): ResticMasterKey {
  mkdirSync(secretDir, { recursive: true });
  const masterPath = path.join(secretDir, RESTIC_MASTER_FILE);
  if (existsSync(masterPath)) {
    const parsed = JSON.parse(readFileSync(masterPath, "utf8")) as {
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
  const master = createMasterKey();
  writeOwnerOnlyFile(
    masterPath,
    JSON.stringify({
      encrypt: master.encrypt.toString("base64"),
      macK: master.macK.toString("base64"),
      macR: master.macR.toString("base64"),
    }),
  );
  writeResticEnvPaths(secretDir);
  return master;
}

export function createHostKekHook(secretDir: string): KekHook {
  return {
    unwrapProjectDek({ projectId }) {
      const filePath = path.join(secretDir, "deks", `${projectId}.json`);
      if (!existsSync(filePath)) {
        throw new Error(`project DEK missing for ${projectId}`);
      }
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { keyId: string; dek: string };
      return { keyId: parsed.keyId, dek: Buffer.from(parsed.dek, "base64") };
    },
  };
}

export function listDekProjectIds(secretDir: string): string[] {
  const root = path.join(secretDir, "deks");
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}

export function listStoreProjectIds(store: StateStore): string[] {
  return store.listProjects(hostBackupScope()).map((project) => project.projectId);
}

export function collectBackupProjectIds(input: {
  store: StateStore;
  secretDir: string;
  casProjectIds: readonly string[];
}): string[] {
  return [
    ...new Set([...input.casProjectIds, ...listDekProjectIds(input.secretDir), ...listStoreProjectIds(input.store)]),
  ];
}

function writeResticEnvPaths(secretDir: string): void {
  writeOwnerOnlyFile(
    path.join(secretDir, RESTIC_ENV_FILE),
    [
      `PI_HEC_RESTIC_MASTER_PATH=${path.join(secretDir, RESTIC_MASTER_FILE)}`,
      `PI_HEC_ONLINE_WRAP_KEY_PATH=${path.join(secretDir, ONLINE_WRAP_FILE)}`,
      "",
    ].join("\n"),
  );
}

function hostBackupScope(): PrincipalScope {
  return {
    [authenticatedScopeBrand]: true,
    principalId: "host-backup",
    identityKind: "admin",
    certificateSerial: "host-backup",
    audiences: ["control"],
    projectGrants: [],
    authenticatedAt: "1970-01-01T00:00:00.000Z",
  };
}
