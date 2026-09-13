import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { guaranteeSetForProfile } from "../../../faex1/apps/control-plane/src/config.js";
import { claimProductionHoldout } from "../../evaluation/harness/section24.js";
import {
  claimProductionGoLive,
  SECTION33_GATE_IDS,
  type ScheduledBackupProof,
  type Section33GateId,
} from "./section33.js";

export type { ScheduledBackupProof } from "./section33.js";

export type GateStatus = "pass" | "fail" | "not-claimed";

export type GoLiveItem = {
  readonly id: string;
  readonly section: "33" | "2.4";
  readonly title: string;
  readonly status: GateStatus;
};

const SECTION33_TITLES: Readonly<Record<Section33GateId, string>> = {
  "local-model-no-mutation":
    "Local model physically has no code mutation/exec/cloud credential capabilities",
  "local-output-not-authoritative":
    "Local output cannot become cloud instruction, ledger requirement, verdict or repair text",
  "e2e-one-completion": "Normal E2E path performs exactly one cloud completion",
  "windows-path-suite": "Windows path adversarial suite passes",
  "disposable-vm-commands": "Project commands execute only in a disposable VM",
  "egress-fail-closed": "Egress DLP and provider contract registry fail closed",
  "approval-replay-toctou": "Approval replay/TOCTOU suite passes",
  "broker-trusted-approval": "Sensitive approval is captured only in broker-owned trusted UI",
  "composite-isolation": "Composite isolation and no-existence-oracle including backups",
  "inline-evidence": "Every cloud request contains inline exact evidence/skill bytes",
  "cas-tamper-restore": "CAS tamper and clean-host restore pass",
  "ambiguous-no-duplicate": "Ambiguous provider outcome does not create an automatic duplicate",
  "unknown-stack-fallback": "Unknown stack uses universal fallback",
  "restart-preserves-run": "Pi restart/session fork/compaction do not lose the run",
  "usage-does-not-limit": "Usage is displayed and does not limit execution",
  "no-prometheus-otel": "Dependencies contain no Prometheus/OpenTelemetry/telemetry exporters",
  "backup-hourly": "Hourly backup timer invokes performBackup",
  "backup-on-terminal": "On-terminal backup invokes performBackup",
  "no-placeholders": "No placeholder, disabled test, unhandled union or known critical finding remains",
  "promotion-crash-safe":
    "Windows promotion crash/race suite commits, rolls back, or enters manual recovery",
};

function statusFromPassed(passed: boolean): GateStatus {
  return passed ? "pass" : "fail";
}

export async function buildGoLiveChecklist(proof?: ScheduledBackupProof): Promise<{
  readonly generatedAt: string;
  readonly holdoutGatesClaimed: boolean;
  readonly section33GatesClaimed: boolean;
  readonly deploymentSecurityProfile: "SINGLE_HOST";
  readonly guarantees: readonly string[];
  readonly items: readonly GoLiveItem[];
}> {
  const holdout = claimProductionHoldout();
  const holdoutStatus: GateStatus = holdout.holdoutGatesClaimed ? "pass" : "not-claimed";
  const section33 = await claimProductionGoLive(proof);
  const section33ById = new Map(section33.gates.map((gate) => [gate.id, gate.passed]));
  const items: GoLiveItem[] = [
    ...SECTION33_GATE_IDS.slice(0, 3).map((id) => ({
      id,
      section: "33" as const,
      title: SECTION33_TITLES[id],
      status: statusFromPassed(section33ById.get(id) === true),
    })),
    {
      id: "holdout-mean-p95-ci",
      section: "2.4",
      title: "One-sided CI gates for mean and p95 cloud completions versus ordinary Pi baseline",
      status: holdoutStatus,
    },
    {
      id: "quality-uplift-2-4",
      section: "2.4",
      title: "Quality uplift matches section 2.4",
      status: holdoutStatus,
    },
    {
      id: "false-verified-rate-2-4",
      section: "2.4",
      title: "False Verified Rate matches section 2.4",
      status: holdoutStatus,
    },
    ...SECTION33_GATE_IDS.slice(3).map((id) => ({
      id,
      section: "33" as const,
      title: SECTION33_TITLES[id],
      status: statusFromPassed(section33ById.get(id) === true),
    })),
  ];
  return {
    generatedAt: "2026-08-29T00:00:00.000Z",
    holdoutGatesClaimed: holdout.holdoutGatesClaimed,
    section33GatesClaimed: section33.section33GatesClaimed,
    deploymentSecurityProfile: "SINGLE_HOST",
    guarantees: guaranteeSetForProfile("SINGLE_HOST"),
    items,
  };
}

export async function writeGoLiveChecklist(
  directory: string,
  proof?: ScheduledBackupProof,
): Promise<string> {
  mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, "go-live-checklist.json");
  const body = `${JSON.stringify(await buildGoLiveChecklist(proof), null, 2)}\n`;
  writeFileSync(filePath, body, "utf8");
  return filePath;
}
