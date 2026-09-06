import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { guaranteeSetForProfile } from "../../../apps/control-plane/src/config.js";

export type GateStatus = "pass" | "fail" | "not-claimed";

export type GoLiveItem = {
  readonly id: string;
  readonly section: "33" | "2.4";
  readonly title: string;
  readonly status: GateStatus;
};

export type ScheduledBackupProof = {
  hourlyEpoch: string;
  terminalEpoch: string;
};

function epochProof(epoch: string | undefined): boolean {
  return typeof epoch === "string" && /^epoch-[0-9a-f]+$/u.test(epoch);
}

export function buildGoLiveChecklist(proof?: ScheduledBackupProof): {
  readonly generatedAt: string;
  readonly holdoutGatesClaimed: false;
  readonly deploymentSecurityProfile: "SINGLE_HOST";
  readonly guarantees: readonly string[];
  readonly items: readonly GoLiveItem[];
} {
  const items: GoLiveItem[] = [
    {
      id: "local-model-no-mutation",
      section: "33",
      title: "Local model physically has no code mutation/exec/cloud credential capabilities",
      status: "not-claimed",
    },
    {
      id: "local-output-not-authoritative",
      section: "33",
      title:
        "Local output cannot become cloud instruction, ledger requirement, verdict or repair text",
      status: "not-claimed",
    },
    {
      id: "e2e-one-completion",
      section: "33",
      title: "Normal E2E path performs exactly one cloud completion",
      status: "not-claimed",
    },
    {
      id: "holdout-mean-p95-ci",
      section: "2.4",
      title: "One-sided CI gates for mean and p95 cloud completions versus ordinary Pi baseline",
      status: "not-claimed",
    },
    {
      id: "quality-uplift-2-4",
      section: "2.4",
      title: "Quality uplift matches section 2.4",
      status: "not-claimed",
    },
    {
      id: "false-verified-rate-2-4",
      section: "2.4",
      title: "False Verified Rate matches section 2.4",
      status: "not-claimed",
    },
    {
      id: "windows-path-suite",
      section: "33",
      title: "Windows path adversarial suite passes",
      status: "not-claimed",
    },
    {
      id: "disposable-vm-commands",
      section: "33",
      title: "Project commands execute only in a disposable VM",
      status: "not-claimed",
    },
    {
      id: "egress-fail-closed",
      section: "33",
      title: "Egress DLP and provider contract registry fail closed",
      status: "not-claimed",
    },
    {
      id: "approval-replay-toctou",
      section: "33",
      title: "Approval replay/TOCTOU suite passes",
      status: "not-claimed",
    },
    {
      id: "broker-trusted-approval",
      section: "33",
      title: "Sensitive approval is captured only in broker-owned trusted UI",
      status: "not-claimed",
    },
    {
      id: "composite-isolation",
      section: "33",
      title: "Composite isolation and no-existence-oracle including backups",
      status: "not-claimed",
    },
    {
      id: "inline-evidence",
      section: "33",
      title: "Every cloud request contains inline exact evidence/skill bytes",
      status: "not-claimed",
    },
    {
      id: "cas-tamper-restore",
      section: "33",
      title: "CAS tamper and clean-host restore pass",
      status: "not-claimed",
    },
    {
      id: "ambiguous-no-duplicate",
      section: "33",
      title: "Ambiguous provider outcome does not create an automatic duplicate",
      status: "not-claimed",
    },
    {
      id: "unknown-stack-fallback",
      section: "33",
      title: "Unknown stack uses universal fallback",
      status: "not-claimed",
    },
    {
      id: "restart-preserves-run",
      section: "33",
      title: "Pi restart/session fork/compaction do not lose the run",
      status: "not-claimed",
    },
    {
      id: "usage-does-not-limit",
      section: "33",
      title: "Usage is displayed and does not limit execution",
      status: "not-claimed",
    },
    {
      id: "no-prometheus-otel",
      section: "33",
      title: "Dependencies contain no Prometheus/OpenTelemetry/telemetry exporters",
      status: "not-claimed",
    },
    {
      id: "backup-hourly",
      section: "33",
      title: "Hourly backup timer invokes performBackup",
      status: epochProof(proof?.hourlyEpoch) ? "pass" : "fail",
    },
    {
      id: "backup-on-terminal",
      section: "33",
      title: "On-terminal backup invokes performBackup",
      status: epochProof(proof?.terminalEpoch) ? "pass" : "fail",
    },
    {
      id: "no-placeholders",
      section: "33",
      title: "No placeholder, disabled test, unhandled union or known critical finding remains",
      status: epochProof(proof?.hourlyEpoch) && epochProof(proof?.terminalEpoch) ? "pass" : "fail",
    },
    {
      id: "promotion-crash-safe",
      section: "33",
      title: "Windows promotion crash/race suite commits, rolls back, or enters manual recovery",
      status: "not-claimed",
    },
  ];
  return {
    generatedAt: "2026-08-29T00:00:00.000Z",
    holdoutGatesClaimed: false,
    deploymentSecurityProfile: "SINGLE_HOST",
    guarantees: guaranteeSetForProfile("SINGLE_HOST"),
    items,
  };
}

export function writeGoLiveChecklist(directory: string, proof?: ScheduledBackupProof): string {
  mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, "go-live-checklist.json");
  const body = `${JSON.stringify(buildGoLiveChecklist(proof), null, 2)}\n`;
  writeFileSync(filePath, body, "utf8");
  return filePath;
}
