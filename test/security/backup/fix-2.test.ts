import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { readLatestBackupUnit, unwrapDek } from "../../../deploy/fa-ex1/backup/procedure.js";
import { runScheduledBackupJob } from "../../../deploy/fa-ex1/backup/run-scheduled.js";
import { verifyResticRepo } from "../../../deploy/fa-ex1/backup/restic-aead.js";
import { assertOwnerOnlyMode } from "../../../deploy/fa-ex1/backup/owner-mode.js";
import {
  bootstrapTrustedWorld,
  openTempStore,
} from "../../../packages/state-store/test/helpers.js";

const DEK = Uint8Array.from({ length: 32 }, (_, index) => index + 11);

function walkFiles(root: string): string[] {
  const found: string[] = [];
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
    found.push(current);
  }
  return found;
}

test("two hourly jobs on the same root append and unwrap DEK with recovery and online-wrap keys", async () => {
  const opened = openTempStore();
  const casRoot = mkdtempSync(path.join(tmpdir(), "hec-cas-h2-"));
  const backupRoot = mkdtempSync(path.join(tmpdir(), "hec-bak-h2-"));
  const secretDir = mkdtempSync(path.join(tmpdir(), "hec-sec-h2-"));
  mkdirSync(casRoot, { recursive: true });
  mkdirSync(path.join(secretDir, "deks"), { recursive: true });
  const recovery = generateKeyPairSync("x25519");
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-hourly");
    writeFileSync(
      path.join(secretDir, "deks", `${world.projectId}.json`),
      JSON.stringify({ keyId: "dek-hourly", dek: Buffer.from(DEK).toString("base64") }),
      "utf8",
    );
    const env = {
      PI_HEC_DB_PATH: opened.dbPath,
      PI_HEC_CAS_ROOT: casRoot,
      PI_HEC_BACKUP_ROOT: backupRoot,
      PI_HEC_HOST_SECRET_DIR: secretDir,
      PI_HEC_HOST_LEASE_KEY: Buffer.from(opened.keys.hostLeaseKey).toString("base64"),
      PI_HEC_DB_RESPONSE_KEY: Buffer.from(opened.keys.dbResponseKey).toString("base64"),
      PI_HEC_RECOVERY_PUBLIC_KEY: recovery.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
    };
    const first = await runScheduledBackupJob("hourly", env);
    const second = await runScheduledBackupJob("hourly", env);
    expect(first).toMatch(/^epoch-/);
    expect(second).toMatch(/^epoch-/);
    expect(second).not.toBe(first);

    const masterRaw = JSON.parse(
      readFileSync(path.join(secretDir, "restic-master.json"), "utf8"),
    ) as {
      encrypt: string;
      macK: string;
      macR: string;
    };
    const master = {
      encrypt: Buffer.from(masterRaw.encrypt, "base64"),
      macK: Buffer.from(masterRaw.macK, "base64"),
      macR: Buffer.from(masterRaw.macR, "base64"),
    };
    const repositoryPath = path.join(backupRoot, "restic-repo");
    verifyResticRepo(repositoryPath, master);
    expect(readdirSync(path.join(repositoryPath, "snapshots")).length).toBeGreaterThanOrEqual(2);

    const online = createPrivateKey({
      key: readFileSync(path.join(secretDir, "online-wrap.pkcs8")),
      format: "der",
      type: "pkcs8",
    });
    const unit = readLatestBackupUnit(repositoryPath, master);
    const wrap = unit.dekWraps.find((item) => item.projectId === world.projectId);
    expect(wrap).toBeDefined();
    expect(unwrapDek(wrap?.recovery ?? "", recovery.privateKey).equals(Buffer.from(DEK))).toBe(
      true,
    );
    expect(unwrapDek(wrap?.online ?? "", online).equals(Buffer.from(DEK))).toBe(true);

    const unitJson = JSON.stringify(unit);
    expect(unitJson).not.toContain(
      readFileSync(path.join(secretDir, "online-wrap.pkcs8")).toString("base64"),
    );
    expect(unitJson).not.toContain(masterRaw.encrypt);
    expect(existsOwnerSecretsOutsideRepo(secretDir, repositoryPath)).toBe(true);

    const sqlite = path.join(backupRoot, second, "control.sqlite");
    expect(() => {
      assertOwnerOnlyMode(path.join(secretDir, "restic-master.json"));
    }).not.toThrow();
    expect(() => {
      assertOwnerOnlyMode(path.join(secretDir, "online-wrap.pkcs8"));
    }).not.toThrow();
    expect(() => {
      assertOwnerOnlyMode(sqlite);
    }).not.toThrow();
    for (const filePath of walkFiles(repositoryPath)) {
      expect(() => {
        assertOwnerOnlyMode(filePath);
      }).not.toThrow();
    }
  } finally {
    opened.close();
  }
});

function existsOwnerSecretsOutsideRepo(secretDir: string, repositoryPath: string): boolean {
  return !secretDir.startsWith(repositoryPath);
}
