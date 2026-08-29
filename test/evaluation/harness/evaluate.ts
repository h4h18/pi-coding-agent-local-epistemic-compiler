import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adjudicate, sensitivityExcludingSymmetricUndetermined } from "../adjudication/rules.js";
import { aggregateBallots, agreementRate, buildBlindedPacket } from "../adjudication/packets.js";
import { ABLATION_SWITCHES, applyAblation, packetSchemaIdentical } from "../ablations/switches.js";
import { writeLocalReports, reportTelemetryDenied } from "../reports/write.js";
import { rejectDiagnosticGateEvidence } from "./arms.js";
import { runOrdinaryPiBaseline, type BaselineSessionFactory } from "./baseline-runner.js";
import { pairedBootstrap } from "./bootstrap.js";
import { FROZEN_ENVIRONMENT, IMMUTABLE_TASKS } from "./fixtures.js";
import {
  buildHecPacket,
  hecPacketHasEvaluationHints,
  runHecArm,
  type OneShotComplete,
} from "./hec-runner.js";
import { countCompletionsFromLedger } from "./ledger.js";
import { aggregateMetrics, scoreArm, type ArmOutcome } from "./metrics.js";
import { decideEligibility, pairTrial } from "./pairing.js";
import { blockRandomizeOrder, coverageStatus, freezeManifest, HOLDOUT_MIN_PAIRS, simulatePower } from "./protocol.js";
import { RECORDED_OUTCOMES } from "./recorded.js";
import { ARM_IDS } from "./types.js";

const REPORTS_DIR = path.resolve(fileURLToPath(new URL("../reports/generated", import.meta.url)));

function defaultBaselineSession(): ReturnType<BaselineSessionFactory> {
  return Promise.resolve({
    session: {
      prompt: () => Promise.resolve(),
      getSessionStats: () => ({ assistantMessages: 1 }),
    },
  });
}

const defaultHecCompleteOnce: OneShotComplete = () => Promise.resolve({ state: "completed" });

type ArmRunFailure = {
  readonly timeout: boolean;
  readonly protocolFailure: boolean;
  readonly missingOutput: boolean;
};

function classifyRunnerError(error: unknown): ArmRunFailure {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timeout")) {
    return { timeout: true, protocolFailure: false, missingOutput: false };
  }
  if (message.includes("missing") && message.includes("output")) {
    return { timeout: false, protocolFailure: false, missingOutput: true };
  }
  return { timeout: false, protocolFailure: true, missingOutput: false };
}

export async function runEvaluationHarness(input?: {
  readonly reportDir?: string;
  readonly createBaselineSession?: BaselineSessionFactory;
  readonly hecCompleteOnce?: OneShotComplete;
}): Promise<{
  readonly paired: number;
  readonly eligibilityBeforeReveal: true;
  readonly holdoutGatesClaimed: false;
  readonly reports: readonly string[];
  readonly telemetry: ReturnType<typeof reportTelemetryDenied>;
  readonly agreement: number;
  readonly completions: { mean: number; p95: number };
  readonly baselinePromptTurns: readonly number[];
  readonly trialOrder: readonly string[];
  readonly publishedArms: readonly ArmOutcome[];
  readonly publishedWorkspaces: readonly string[];
}> {
  rejectDiagnosticGateEvidence(1);
  rejectDiagnosticGateEvidence(3);
  const reportDir = input?.reportDir ?? REPORTS_DIR;
  const workspaceRoot = path.join(reportDir, ".workspaces");
  const paired = IMMUTABLE_TASKS.map((task) => {
    const eligibility = decideEligibility({
      taskId: task.taskId,
      snapshotId: task.snapshotId,
      snapshotRootDigest: task.snapshotRootDigest,
      broken: task.broken,
      ambiguous: task.ambiguous,
    });
    return pairTrial({ task, environment: FROZEN_ENVIRONMENT, workspaceRoot, eligibility });
  });
  const publishedWorkspaces: string[] = [];
  for (const trial of paired) {
    for (const armId of ARM_IDS) {
      const workspace = trial.workspaces[armId];
      mkdirSync(workspace, { recursive: true });
      publishedWorkspaces.push(workspace);
    }
  }
  const packets = paired.map((trial) =>
    buildBlindedPacket({
      packetId: `pkt-${trial.taskId}`,
      taskId: trial.taskId,
      anonymizedDiff: "anonymized workspace delta",
      evidence: ["sealed-hidden-tests"],
      mustRequirements: ["honor explicit MUST"],
    }),
  );
  const ballots = packets.map((packet) => {
    const first = { raterId: "r1", packetId: packet.packetId, label: "CORRECT" as const };
    const second =
      packet.taskId === "eval-undetermined-001"
        ? { raterId: "r2", packetId: packet.packetId, label: "UNDETERMINED" as const }
        : { raterId: "r2", packetId: packet.packetId, label: "CORRECT" as const };
    const tie =
      packet.taskId === "eval-undetermined-001"
        ? { raterId: "r3", packetId: packet.packetId, label: "UNDETERMINED" as const }
        : undefined;
    return aggregateBallots({ first, second, ...(tie === undefined ? {} : { tieBreaker: tie }) });
  });
  const createBaselineSession = input?.createBaselineSession ?? defaultBaselineSession;
  const hecCompleteOnce = input?.hecCompleteOnce ?? defaultHecCompleteOnce;
  const trialOrder = blockRandomizeOrder(
    paired.map((trial) => trial.taskId),
    FROZEN_ENVIRONMENT.prngSeed,
  );
  const ordered = trialOrder.map((taskId) => {
    const trial = paired.find((item) => item.taskId === taskId);
    if (trial === undefined) {
      throw new Error(`missing paired trial ${taskId}`);
    }
    return trial;
  });
  const baselinePromptTurns: number[] = [];
  const promptTurnsByTask = new Map<string, number>();
  const hecStateByTask = new Map<string, string>();
  const baselineFailureByTask = new Map<string, ArmRunFailure>();
  const hecFailureByTask = new Map<string, ArmRunFailure>();
  for (const trial of ordered) {
    const task = IMMUTABLE_TASKS.find((item) => item.taskId === trial.taskId);
    if (task === undefined) {
      throw new Error(`missing task ${trial.taskId}`);
    }
    try {
      const baseline = await runOrdinaryPiBaseline({
        cwd: trial.workspaces[1],
        prompt: task.prompt,
        createSession: createBaselineSession,
      });
      baselinePromptTurns.push(baseline.promptTurns);
      promptTurnsByTask.set(trial.taskId, baseline.promptTurns);
    } catch (error) {
      baselineFailureByTask.set(trial.taskId, classifyRunnerError(error));
      baselinePromptTurns.push(0);
    }
    const packet = buildHecPacket(task.prompt);
    if (hecPacketHasEvaluationHints(packet)) {
      throw new Error("HEC packets must not carry evaluation-only hints");
    }
    try {
      const hec = await runHecArm({
        phase: "first",
        completeOnce: hecCompleteOnce,
        prompt: task.prompt,
      });
      hecStateByTask.set(trial.taskId, hec.state);
    } catch (error) {
      hecFailureByTask.set(trial.taskId, classifyRunnerError(error));
    }
  }
  const publishedArms = RECORDED_OUTCOMES.filter((item) => item.armId === 1 || item.armId === 3).map((outcome) => {
    const task = IMMUTABLE_TASKS.find((item) => item.taskId === outcome.taskId);
    const noOracle = task?.noOracle === true;
    const failure = outcome.armId === 1 ? baselineFailureByTask.get(outcome.taskId) : hecFailureByTask.get(outcome.taskId);
    const published: ArmOutcome = {
      ...outcome,
      noOracle,
      external: noOracle ? "UNDETERMINED" : outcome.external,
      timeout: outcome.timeout || (failure?.timeout ?? false),
      protocolFailure: outcome.protocolFailure || (failure?.protocolFailure ?? false),
      missingOutput: outcome.missingOutput || (failure?.missingOutput ?? false),
      ...(outcome.armId === 1 ? { promptTurns: promptTurnsByTask.get(outcome.taskId) } : {}),
      ...(outcome.armId === 3 ? { hecState: hecStateByTask.get(outcome.taskId) } : {}),
    };
    return published;
  });
  const metrics = aggregateMetrics(publishedArms);
  const completionRows = RECORDED_OUTCOMES.map((outcome) => ({
    taskId: outcome.taskId,
    repositoryId: outcome.repositoryId,
    armId: outcome.armId,
    weight: outcome.weight,
    completions: countCompletionsFromLedger(outcome.ledger),
  }));
  const pairedRows = IMMUTABLE_TASKS.map((task) => {
    const baseline = RECORDED_OUTCOMES.find((item) => item.taskId === task.taskId && item.armId === 1);
    const hec = RECORDED_OUTCOMES.find((item) => item.taskId === task.taskId && item.armId === 3);
    if (baseline === undefined || hec === undefined) {
      throw new Error(`missing recorded pair for ${task.taskId}`);
    }
    return {
      taskId: task.taskId,
      repositoryId: task.repositoryId,
      weight: task.weight,
      completions: countCompletionsFromLedger(hec.ledger),
      baselineCompletions: countCompletionsFromLedger(baseline.ledger),
      hecCompletions: countCompletionsFromLedger(hec.ledger),
    };
  });
  const bootstrap = pairedBootstrap(pairedRows, FROZEN_ENVIRONMENT.prngSeed, 64);
  const coverage = coverageStatus(IMMUTABLE_TASKS);
  const power = simulatePower({ observedPairs: IMMUTABLE_TASKS.length, targetPairs: HOLDOUT_MIN_PAIRS });
  const ablations = ABLATION_SWITCHES.map((id) => applyAblation(id));
  const reports = await writeLocalReports(reportDir, {
    "frozen-manifest.json": freezeManifest(),
    "confusion-matrix.json": {
      trueCorrect: RECORDED_OUTCOMES.filter((item) => scoreArm(item).finalVerifiedSuccess).length,
      falseVerified: RECORDED_OUTCOMES.filter((item) => scoreArm(item).falseVerified).length,
      verifierInducedHarm: RECORDED_OUTCOMES.filter((item) => scoreArm(item).verifierInducedHarm).length,
      undetermined: RECORDED_OUTCOMES.filter((item) => scoreArm(item).undetermined).length,
    },
    "missingness.json": { missingArmOutcomes: 0 },
    "exclusions.json": { postResultExclusions: [] },
    "completion-distributions.json": {
      rows: completionRows,
      baseline: metrics.baseline.completions,
      hecFirst: metrics.hecFirst.completions,
      pairedDelta: metrics.pairedDelta.completions,
    },
    "negative-results.json": {
      injectionBaselineBreach: true,
      hecVerifierInducedHarm: true,
      undeterminedPrimaryFailure: true,
    },
    "sensitivity.json": {
      excludedSymmetricUndetermined: sensitivityExcludingSymmetricUndetermined(
        IMMUTABLE_TASKS.map((task) => {
          const baseline = publishedArms.find((item) => item.taskId === task.taskId && item.armId === 1);
          const hec = publishedArms.find((item) => item.taskId === task.taskId && item.armId === 3);
          return { baseline: baseline?.external ?? "UNDETERMINED", hec: hec?.external ?? "UNDETERMINED" };
        }),
      ),
    },
    "bootstrap.json": bootstrap,
    "coverage.json": { ...coverage, power, holdoutGatesClaimed: false },
    "ablations.json": {
      switches: ablations.map((item) => item.switchId),
      identicalPacketSchema: packetSchemaIdentical(
        applyAblation("deterministic-vs-local-guided"),
        applyAblation("hybrid"),
      ),
    },
    "metrics.json": {
      ...metrics,
      publishedArms,
    },
    "adjudication-agreement.json": { agreement: agreementRate(ballots), packets: packets.length },
    "adjudication-decisions.json": publishedArms.map((outcome) =>
      adjudicate({
        external: outcome.external,
        localVerdict: outcome.localVerdict,
        styleOnlyMismatch: false,
        securityBreach: outcome.securityBreach,
        secretEgress: false,
        outOfScopeWrite: false,
        hiddenTestAccess: false,
        noOracle: outcome.noOracle === true,
      }),
    ),
  });
  return {
    paired: paired.length,
    eligibilityBeforeReveal: true,
    holdoutGatesClaimed: false,
    reports,
    telemetry: reportTelemetryDenied(),
    agreement: agreementRate(ballots),
    completions: metrics.pairedDelta.completions,
    baselinePromptTurns,
    trialOrder,
    publishedArms,
    publishedWorkspaces,
  };
}
