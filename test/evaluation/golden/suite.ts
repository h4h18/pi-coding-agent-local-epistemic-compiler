import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunState } from "@pi-hec/contracts";
import { reportTelemetryDenied, writeLocalReports } from "../reports/write.js";
import { applyEdits, restoreGoldenWorkspace } from "./apply.js";
import { GOLDEN_TASKS, materializeGoldenRepo } from "./catalog.js";
import { aggregateGoldenMetrics, completeTrial, primaryMetric } from "./metrics.js";
import { scoreOracle } from "./score.js";
import { REGRESSION_TEST, SERIALIZED_SESSION } from "./sources.js";
import { readWorkspaceFile } from "./tree.js";
import type {
  ArchitecturalDisposition,
  GoldenHeadline,
  GoldenRepoId,
  GoldenTask,
  GoldenTrialRecord,
  MaterializedRepo,
  TaskKind,
  TrialObservation,
} from "./types.js";
import { GOLDEN_REPO_IDS, TASK_KINDS } from "./types.js";

export const SUITE_ARMS = ["gold", "false-ready", "honest-blocked", "repair"] as const;

export type SuiteArmId = (typeof SUITE_ARMS)[number];

export type GoldenTrialSummary = {
  readonly arm: SuiteArmId;
  readonly taskId: string;
  readonly repoId: GoldenRepoId;
  readonly kind: TaskKind;
  readonly disposition: ArchitecturalDisposition;
  readonly acceptanceSuccess: boolean;
  readonly falseReady: boolean;
  readonly firstPassSuccess: boolean;
  readonly repairConverged: boolean | null;
  readonly recoverySuccess: boolean | null;
  readonly scopePrecision: number;
  readonly evidenceCoverage: number;
  readonly regression: boolean;
  readonly cost: number | null;
  readonly latencyMs: number | null;
};

export type ArmReport = {
  readonly arm: SuiteArmId;
  readonly primary: ReturnType<typeof primaryMetric>;
  readonly headline: GoldenHeadline;
};

export type GoldenConfusion = {
  readonly goldAccepted: number;
  readonly goldRejected: number;
  readonly goldFalseReady: number;
  readonly falseReadyProbes: number;
  readonly falseReadyCaught: number;
  readonly honestBlocked: number;
  readonly honestBlockedFalseReady: number;
  readonly repairAttempted: number;
  readonly repairConverged: number;
};

export type GoldenSuiteReport = {
  readonly generatedAt: string;
  readonly telemetry: ReturnType<typeof reportTelemetryDenied>;
  readonly primaryMetric: ReturnType<typeof primaryMetric> & {
    readonly arm: "false-ready";
    readonly note: "false READY on the adversarial READY probe; gold must stay at 0";
  };
  readonly arms: Record<SuiteArmId, ArmReport>;
  readonly confusion: GoldenConfusion;
  readonly byRepo: Record<GoldenRepoId, Record<SuiteArmId, GoldenHeadline>>;
  readonly byKind: Record<TaskKind, Record<SuiteArmId, GoldenHeadline>>;
  readonly trials: readonly GoldenTrialSummary[];
  readonly written: readonly string[];
};

export function goldenGeneratedReportDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "reports", "generated");
}

function regressionTestPath(session: string): string {
  const sessionDir = session.split("/").slice(0, -1).join("/");
  return `${sessionDir}/refresh.regression.test.ts`;
}

function goldDisposition(task: GoldenTask): ArchitecturalDisposition {
  return task.oracle.expectedDisposition ?? "READY";
}

function goldRunState(disposition: ArchitecturalDisposition): RunState {
  return disposition === "BLOCKED" ? "BLOCKED" : "VERIFIED_ACCEPTED";
}

function falseReadyEdits(task: GoldenTask, materialized: MaterializedRepo): Readonly<Record<string, string>> {
  const sessionPath = materialized.paths.session;
  if (task.kind === "research") {
    const current = readWorkspaceFile(materialized.root, sessionPath) ?? "";
    return { [sessionPath]: `${current}\nexport const evalTouched = true;\n` };
  }
  if (task.kind === "bug") {
    return {
      [sessionPath]: SERIALIZED_SESSION,
      [regressionTestPath(sessionPath)]: REGRESSION_TEST,
    };
  }
  return {};
}

function observe(input: {
  readonly task: GoldenTask;
  readonly arm: SuiteArmId;
  readonly latencyMs: number;
}): TrialObservation {
  const { task, arm, latencyMs } = input;
  const cost = 0.01 * Math.max(1, task.oracle.requiredEvidence.length);
  switch (arm) {
    case "gold": {
      const disposition = goldDisposition(task);
      return {
        declaredDisposition: disposition,
        statesVisited: [goldRunState(disposition)],
        repairCount: 0,
        userInputCount: 0,
        recovered: false,
        recoveryAttempted: false,
        evidencePresent: [...task.oracle.requiredEvidence],
        cost,
        latencyMs,
        firstPass: true,
      };
    }
    case "false-ready":
      return {
        declaredDisposition: "READY",
        statesVisited: ["VERIFIED_ACCEPTED"],
        repairCount: 0,
        userInputCount: 0,
        recovered: false,
        recoveryAttempted: false,
        evidencePresent: [...task.oracle.requiredEvidence],
        cost,
        latencyMs,
        firstPass: true,
      };
    case "honest-blocked":
      return {
        declaredDisposition: "BLOCKED",
        statesVisited: ["BLOCKED"],
        repairCount: 0,
        userInputCount: 0,
        recovered: false,
        recoveryAttempted: false,
        evidencePresent: [],
        cost,
        latencyMs,
        firstPass: true,
      };
    case "repair": {
      const disposition = goldDisposition(task);
      return {
        declaredDisposition: disposition,
        statesVisited: [goldRunState(disposition)],
        repairCount: 1,
        userInputCount: 0,
        recovered: false,
        recoveryAttempted: false,
        evidencePresent: [...task.oracle.requiredEvidence],
        cost,
        latencyMs,
        firstPass: false,
      };
    }
    default: {
      const exhaustive: never = arm;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function runTrial(
  task: GoldenTask,
  materialized: MaterializedRepo,
  arm: SuiteArmId,
): GoldenTrialRecord {
  restoreGoldenWorkspace(materialized);
  const started = Date.now();
  switch (arm) {
    case "gold":
    case "repair":
      applyEdits(materialized.root, task.oracle.solverEdits);
      break;
    case "false-ready":
      applyEdits(materialized.root, falseReadyEdits(task, materialized));
      break;
    case "honest-blocked":
      break;
    default: {
      const exhaustive: never = arm;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
  const observation = observe({ task, arm, latencyMs: Date.now() - started });
  const score = scoreOracle({ task, materialized, observation });
  return completeTrial(task.taskId, task.repoId, task.kind, observation, score);
}

function summarize(arm: SuiteArmId, trial: GoldenTrialRecord): GoldenTrialSummary {
  return {
    arm,
    taskId: trial.taskId,
    repoId: trial.repoId,
    kind: trial.kind,
    disposition: trial.observation.declaredDisposition,
    acceptanceSuccess: trial.score.acceptanceSuccess,
    falseReady: trial.falseReady,
    firstPassSuccess: trial.firstPassSuccess,
    repairConverged: trial.repairConverged,
    recoverySuccess: trial.recoverySuccess,
    scopePrecision: trial.score.scopePrecision,
    evidenceCoverage: trial.score.evidenceCoverage,
    regression: trial.score.regression,
    cost: trial.observation.cost,
    latencyMs: trial.observation.latencyMs,
  };
}

function armHeadlineMap(
  trials: Readonly<Record<SuiteArmId, readonly GoldenTrialRecord[]>>,
): Record<SuiteArmId, GoldenHeadline> {
  return {
    gold: aggregateGoldenMetrics(trials.gold),
    "false-ready": aggregateGoldenMetrics(trials["false-ready"]),
    "honest-blocked": aggregateGoldenMetrics(trials["honest-blocked"]),
    repair: aggregateGoldenMetrics(trials.repair),
  };
}

function armReport(arm: SuiteArmId, trials: readonly GoldenTrialRecord[]): ArmReport {
  const headline = aggregateGoldenMetrics(trials);
  return {
    arm,
    primary: primaryMetric(headline),
    headline,
  };
}

function sliceBy(
  records: Readonly<Record<SuiteArmId, readonly GoldenTrialRecord[]>>,
  match: (trial: GoldenTrialRecord) => boolean,
): Record<SuiteArmId, GoldenTrialRecord[]> {
  return {
    gold: records.gold.filter(match),
    "false-ready": records["false-ready"].filter(match),
    "honest-blocked": records["honest-blocked"].filter(match),
    repair: records.repair.filter(match),
  };
}

export async function runGoldenSuite(reportDir = goldenGeneratedReportDir()): Promise<GoldenSuiteReport> {
  const records: Record<SuiteArmId, GoldenTrialRecord[]> = {
    gold: [],
    "false-ready": [],
    "honest-blocked": [],
    repair: [],
  };
  const summaries: GoldenTrialSummary[] = [];
  for (const repoId of GOLDEN_REPO_IDS) {
    const materialized = materializeGoldenRepo(repoId);
    try {
      for (const task of GOLDEN_TASKS.filter((item) => item.repoId === repoId)) {
        for (const arm of ["gold", "false-ready", "honest-blocked"] as const) {
          const trial = runTrial(task, materialized, arm);
          records[arm].push(trial);
          summaries.push(summarize(arm, trial));
        }
        if (task.kind === "bug") {
          const trial = runTrial(task, materialized, "repair");
          records.repair.push(trial);
          summaries.push(summarize("repair", trial));
        }
      }
    } finally {
      rmSync(materialized.root, { recursive: true, force: true });
    }
  }
  const arms: Record<SuiteArmId, ArmReport> = {
    gold: armReport("gold", records.gold),
    "false-ready": armReport("false-ready", records["false-ready"]),
    "honest-blocked": armReport("honest-blocked", records["honest-blocked"]),
    repair: armReport("repair", records.repair),
  };
  const byRepo = {} as Record<GoldenRepoId, Record<SuiteArmId, GoldenHeadline>>;
  for (const repoId of GOLDEN_REPO_IDS) {
    byRepo[repoId] = armHeadlineMap(sliceBy(records, (item) => item.repoId === repoId));
  }
  const byKind = {} as Record<TaskKind, Record<SuiteArmId, GoldenHeadline>>;
  for (const kind of TASK_KINDS) {
    byKind[kind] = armHeadlineMap(sliceBy(records, (item) => item.kind === kind));
  }
  const confusion: GoldenConfusion = {
    goldAccepted: records.gold.filter((item) => item.score.acceptanceSuccess).length,
    goldRejected: records.gold.filter((item) => !item.score.acceptanceSuccess).length,
    goldFalseReady: records.gold.filter((item) => item.falseReady).length,
    falseReadyProbes: records["false-ready"].length,
    falseReadyCaught: records["false-ready"].filter((item) => item.falseReady).length,
    honestBlocked: records["honest-blocked"].length,
    honestBlockedFalseReady: records["honest-blocked"].filter((item) => item.falseReady).length,
    repairAttempted: records.repair.length,
    repairConverged: records.repair.filter((item) => item.repairConverged === true).length,
  };
  const generatedAt = new Date().toISOString();
  const probePrimary = primaryMetric(arms["false-ready"].headline);
  const payload: Omit<GoldenSuiteReport, "written"> = {
    generatedAt,
    telemetry: reportTelemetryDenied(),
    primaryMetric: {
      ...probePrimary,
      arm: "false-ready",
      note: "false READY on the adversarial READY probe; gold must stay at 0",
    },
    arms,
    confusion,
    byRepo,
    byKind,
    trials: summaries,
  };
  const written = await writeLocalReports(reportDir, {
    "golden-metrics.json": {
      generatedAt,
      telemetry: payload.telemetry,
      primaryMetric: payload.primaryMetric,
      arms: payload.arms,
      confusion: payload.confusion,
      byRepo: payload.byRepo,
      byKind: payload.byKind,
    },
    "golden-trials.json": {
      generatedAt,
      trials: summaries,
    },
  });
  return { ...payload, written };
}
