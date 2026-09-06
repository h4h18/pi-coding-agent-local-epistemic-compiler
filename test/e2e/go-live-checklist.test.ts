import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runScheduledBackupJob } from "../../deploy/fa-ex1/backup/run-scheduled.js";
import { bootstrapTrustedWorld, openTempStore } from "../../packages/state-store/test/helpers.js";
import { buildGoLiveChecklist, writeGoLiveChecklist } from "./golive/checklist.js";

test("go-live checklist exists and section 2.4 holdout items are not-claimed", async () => {
  const opened = openTempStore();
  const casRoot = mkdtempSync(path.join(tmpdir(), "hec-cas-gl-"));
  const backupRoot = mkdtempSync(path.join(tmpdir(), "hec-bak-gl-"));
  const secretDir = mkdtempSync(path.join(tmpdir(), "hec-sec-gl-"));
  mkdirSync(casRoot, { recursive: true });
  mkdirSync(path.join(secretDir, "deks"), { recursive: true });
  const recovery = generateKeyPairSync("x25519");
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-golive");
    writeFileSync(
      path.join(secretDir, "deks", `${world.projectId}.json`),
      JSON.stringify({
        keyId: "dek-golive",
        dek: Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 5)).toString(
          "base64",
        ),
      }),
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
    const hourlyEpoch = await runScheduledBackupJob("hourly", env);
    const terminalEpoch = await runScheduledBackupJob("on-terminal", {
      ...env,
      PI_HEC_BACKUP_ROOT: path.join(backupRoot, "terminal"),
    });
    expect(hourlyEpoch).toMatch(/^epoch-/);
    expect(terminalEpoch).toMatch(/^epoch-/);

    const checklist = buildGoLiveChecklist({ hourlyEpoch, terminalEpoch });
    expect(checklist.holdoutGatesClaimed).toBe(false);
    const holdout = checklist.items.filter((item) => item.section === "2.4");
    expect(holdout.length).toBeGreaterThanOrEqual(3);
    expect(holdout.every((item) => item.status === "not-claimed")).toBe(true);
    expect(checklist.guarantees).toContain("FA_ROOT_CONFIDENTIALITY_NOT_CLAIMED");
    expect(checklist.guarantees).toContain("FA_ROOT_CREDENTIAL_LOSS");
    const quality = checklist.items.find((item) => item.id === "quality-uplift-2-4");
    expect(quality?.status).toBe("not-claimed");
    const target = mkdtempSync(path.join(tmpdir(), "hec-golive-"));
    const written = writeGoLiveChecklist(target, { hourlyEpoch, terminalEpoch });
    const parsed = JSON.parse(readFileSync(written, "utf8")) as { holdoutGatesClaimed: boolean };
    expect(parsed.holdoutGatesClaimed).toBe(false);
    expect(checklist.items.filter((item) => item.status === "fail")).toEqual([]);
    const hourly = checklist.items.find((item) => item.id === "backup-hourly");
    const terminal = checklist.items.find((item) => item.id === "backup-on-terminal");
    expect(hourly?.status).toBe("pass");
    expect(terminal?.status).toBe("pass");
    const existsOnlyIds = [
      "local-model-no-mutation",
      "local-output-not-authoritative",
      "e2e-one-completion",
      "windows-path-suite",
      "disposable-vm-commands",
      "egress-fail-closed",
      "approval-replay-toctou",
      "broker-trusted-approval",
      "composite-isolation",
      "inline-evidence",
      "cas-tamper-restore",
      "ambiguous-no-duplicate",
      "unknown-stack-fallback",
      "restart-preserves-run",
      "usage-does-not-limit",
      "no-prometheus-otel",
      "promotion-crash-safe",
    ];
    for (const id of existsOnlyIds) {
      expect(checklist.items.find((item) => item.id === id)?.status, id).toBe("not-claimed");
    }
  } finally {
    opened.close();
  }
});
