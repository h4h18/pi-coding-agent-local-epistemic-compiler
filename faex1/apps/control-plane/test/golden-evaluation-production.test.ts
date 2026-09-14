import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { constructPrincipalScope } from "@pi-hec/security";
import { recoverOperations } from "../src/orchestration/recovery.js";
import { FAEX1_WORKER_RUNNER_ID, drainWorkerUntilIdle } from "../src/worker-agent.js";
import { applyEdits } from "../../../../test/evaluation/golden/apply.js";
import { goldenTask, materializeGoldenRepo } from "../../../../test/evaluation/golden/catalog.js";
import { workspaceOracleLeaks } from "../../../../test/evaluation/golden/concealment.js";
import {
  aggregateGoldenMetrics,
  completeTrial,
  primaryMetric,
} from "../../../../test/evaluation/golden/metrics.js";
import { runGoldenProductionTrial } from "../../../../test/evaluation/golden/production/driver.js";
import { drainHostRunnerUntilIdle } from "../../../../test/evaluation/golden/production/host-runner.js";
import {
  FAST_EVAL_ROLES,
  createEvalScriptedRuntime,
} from "../../../../test/evaluation/golden/production/scripted-runtime.js";
import { scoreOracle } from "../../../../test/evaluation/golden/score.js";
import { SERIALIZED_SESSION } from "../../../../test/evaluation/golden/sources.js";
import { writeLocalReports } from "../../../../test/evaluation/reports/write.js";
import {
  HOST_CAPABILITY,
  HOST_POLICY,
  PROJECT_ID,
  RUNNER_ID,
  WORKSPACE_ID,
  startHarness,
  type Harness,
} from "./harness.js";

let harness: Harness | undefined;
let overlayRoot: string | undefined;

beforeAll(async () => {
  overlayRoot = mkdtempSync(path.join(tmpdir(), "pi-hec-overlay-"));
  process.env.PI_HEC_AGENT_OVERLAY_ROOT = overlayRoot;
  harness = await startHarness();
});

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
  }
  if (overlayRoot !== undefined) {
    rmSync(overlayRoot, { recursive: true, force: true });
  }
});

function requireHarness(): Harness {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  return harness;
}

test("/hec drives a golden task through FA-EX1 control plane and worker", async () => {
  const world = requireHarness();
  const task = goldenTask("golden/node-backend/bug");
  const materialized = materializeGoldenRepo("node-backend");
  try {
    expect(workspaceOracleLeaks(materialized.root)).toEqual([]);
    world.listening.ctx.agentRuntime = undefined;
    const result = await runGoldenProductionTrial({
      task,
      materialized,
      world: {
        clock: world.clock,
        broker: world.broker,
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
      },
      drain: () =>
        drainWorkerUntilIdle({
          client: world.worker,
          runtime: createEvalScriptedRuntime({
            now: world.clock,
            objective: task.prompt,
            solverEdits: task.oracle.solverEdits,
          }),
          runnerId: FAEX1_WORKER_RUNNER_ID,
          capabilitiesObjectDigest: HOST_CAPABILITY,
        }),
      drainRunner: () =>
        drainHostRunnerUntilIdle({
          client: world.runner,
          runnerId: RUNNER_ID,
          capabilitiesObjectDigest: HOST_CAPABILITY,
          workspaceRootById: { [WORKSPACE_ID]: materialized.root },
          now: world.clock,
        }),
      recover: () => {
        recoverOperations({
          store: world.store,
          adminScope: constructPrincipalScope({
            record: world.listening.ctx.hostAdminRecord,
            grants: [
              {
                projectId: PROJECT_ID,
                roles: ["admin"],
                grantObjectDigest: HOST_POLICY,
                revokedAt: undefined,
              },
            ],
            authenticatedAt: world.clock(),
          }),
          now: world.clock(),
          errorDigest: world.listening.ctx.hostPolicyDigest,
        });
        return Promise.resolve(true);
      },
    });
    expect(result.pi.notifications.some((line) => line.startsWith("HEC started run_"))).toBe(true);
    expect(result.broker.lastError).toBeUndefined();
    expect(result.run.state).toBe("SUCCEEDED");
    expect(result.drained).toBe(FAST_EVAL_ROLES.length);
    expect(result.runnerDrained).toBe(1);
    expect(result.broker.lastAgents?.profileId).toBe("FAST");
    expect(new Set(result.broker.lastAgents?.agents.map((agent) => agent.role) ?? [])).toEqual(
      new Set(FAST_EVAL_ROLES),
    );
    expect(result.pi.notifications.some((line) => line.includes("HEC recover"))).toBe(true);
    expect(result.trial.falseReady).toBe(false);
    expect(result.trial.observation.declaredDisposition).toBe("READY");
    expect(result.trial.score.acceptanceSuccess).toBe(true);
    expect(result.trial.recoverySuccess).toBe(true);
    const headline = aggregateGoldenMetrics([result.trial]);
    await writeLocalReports(
      path.join(fileURLToPath(new URL("../../../../test/evaluation/reports/generated", import.meta.url))),
      {
        "golden-production.json": {
          generatedAt: new Date().toISOString(),
          flow: "in-process /hec + FA-EX1 control-plane + snapshot capture + worker drain + apply + recover",
          runId: result.run.runId,
          runState: result.run.state,
          drained: result.drained,
          runnerDrained: result.runnerDrained,
          recovered: result.recovered,
          profileId: result.broker.lastAgents?.profileId,
          roles: result.broker.lastAgents?.agents.map((agent) => agent.role) ?? [],
          notifications: result.pi.notifications,
          primary: primaryMetric(headline),
          headline,
          trial: {
            taskId: result.trial.taskId,
            falseReady: result.trial.falseReady,
            acceptanceSuccess: result.trial.score.acceptanceSuccess,
            disposition: result.trial.observation.declaredDisposition,
            recoverySuccess: result.trial.recoverySuccess,
            latencyMs: result.trial.observation.latencyMs,
          },
        },
      },
    );
  } finally {
    world.listening.ctx.agentRuntime = undefined;
    rmSync(materialized.root, { recursive: true, force: true });
  }
});

test("false READY is recorded when HEC would accept a globally serialized patch", () => {
  const task = goldenTask("golden/node-backend/bug");
  const materialized = materializeGoldenRepo("node-backend");
  try {
    applyEdits(materialized.root, { [materialized.paths.session]: SERIALIZED_SESSION });
    const observation = {
      declaredDisposition: "READY" as const,
      statesVisited: ["VERIFIED_ACCEPTED" as const],
      repairCount: 0,
      userInputCount: 0,
      recovered: false,
      recoveryAttempted: false,
      evidencePresent: ["regression-test" as const],
      cost: 0.4,
      latencyMs: 1200,
      firstPass: true,
    };
    const score = scoreOracle({ task, materialized, observation });
    const trial = completeTrial(task.taskId, task.repoId, task.kind, observation, score);
    const headline = aggregateGoldenMetrics([trial]);
    expect(trial.falseReady).toBe(true);
    expect(primaryMetric(headline).name).toBe("falseReadyRate");
    expect(headline.falseReadyRate).toBe(1);
  } finally {
    rmSync(materialized.root, { recursive: true, force: true });
  }
});

test("golden suite writes a local metrics report without telemetry", async () => {
  const task = goldenTask("golden/node-backend/bug");
  const materialized = materializeGoldenRepo("node-backend");
  const reportDir = mkdtempSync(path.join(tmpdir(), "golden-report-"));
  try {
    applyEdits(materialized.root, task.oracle.solverEdits);
    const observation = {
      declaredDisposition: "READY" as const,
      statesVisited: ["AWAITING_APPLY_APPROVAL" as const],
      repairCount: 0,
      userInputCount: 0,
      recovered: false,
      recoveryAttempted: false,
      evidencePresent: ["regression-test" as const, "review-findings" as const],
      cost: 0.11,
      latencyMs: 900,
      firstPass: true,
    };
    const score = scoreOracle({ task, materialized, observation });
    const trial = completeTrial(task.taskId, task.repoId, task.kind, observation, score);
    const headline = aggregateGoldenMetrics([trial]);
    const reports = await writeLocalReports(reportDir, {
      "golden-metrics.json": { primary: primaryMetric(headline), headline, trials: [trial] },
    });
    expect(reports).toHaveLength(1);
    expect(headline.falseReadyRate).toBe(0);
    expect(trial.score.acceptanceSuccess).toBe(true);
  } finally {
    rmSync(materialized.root, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
  }
});
