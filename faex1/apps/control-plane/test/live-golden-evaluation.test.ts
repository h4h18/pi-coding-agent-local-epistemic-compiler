import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { asRunId } from "@pi-hec/contracts";
import { goldenTask, materializeGoldenRepo } from "../../../../test/evaluation/golden/catalog.js";
import {
  promptLeaksOracle,
  workspaceOracleLeaks,
} from "../../../../test/evaluation/golden/concealment.js";
import {
  aggregateGoldenMetrics,
  primaryMetric,
} from "../../../../test/evaluation/golden/metrics.js";
import { ControlPlaneBroker } from "../../../../test/evaluation/golden/production/control-broker.js";
import { runGoldenProductionTrial } from "../../../../test/evaluation/golden/production/driver.js";
import { drainHostRunnerUntilIdle } from "../../../../test/evaluation/golden/production/host-runner.js";
import {
  liveFastDagReachedOutcome,
  liveFastDagTimeoutMs,
} from "../../../../test/evaluation/golden/production/live-fast-dag.js";
import { waitForLiveFastDag } from "../../../../test/evaluation/golden/production/wait-live-fast-dag.js";
import {
  liveGoldenStackReady,
  openLiveGoldenWorld,
} from "../../../../test/evaluation/golden/production/live.js";
import { writeLocalReports } from "../../../../test/evaluation/reports/write.js";

const ready = liveGoldenStackReady();
const opened = ready ? openLiveGoldenWorld() : undefined;

afterAll(() => {
  opened?.client.close();
  opened?.runner.close();
});

test.skipIf(!ready)(
  "/hec golden task waits for the live FA-EX1 worker FAST DAG",
  { timeout: liveFastDagTimeoutMs() + 60_000 },
  async () => {
    if (opened === undefined) {
      throw new Error("live golden stack was not opened");
    }
    const resumeRunId = process.env.PI_HEC_LIVE_RUN_ID;
    if (resumeRunId !== undefined && resumeRunId.length > 0) {
      const broker = new ControlPlaneBroker(opened.world);
      const run = await waitForLiveFastDag({ broker, runId: asRunId(resumeRunId) });
      expect(liveFastDagReachedOutcome(run.state)).toBe(true);
      expect(run.state).not.toBe("CREATED");
      expect(run.state).not.toBe("SNAPSHOT_REQUESTED");
      expect(run.state).not.toBe("PREFLIGHT_COMPLETE");
      expect(run.state).not.toBe("PROFILE_RUNNING");
      const agents = broker.lastAgents;
      expect(agents).toBeDefined();
      if (agents === undefined) {
        throw new Error("live FAST DAG agents missing");
      }
      expect(agents.agents.length).toBeGreaterThan(0);
      process.stdout.write(
        `FAEX1_LIVE_GOLDEN_RUN=${run.runId} STATE=${run.state} PROFILE=${agents.profileId ?? "-"} AGENTS=${agents.agents.map((agent) => `${agent.nodeId}:${agent.status}`).join(",")}\n`,
      );
      await writeLocalReports(
        path.join(fileURLToPath(new URL("../../../../test/evaluation/reports/generated", import.meta.url))),
        {
          "golden-production-live.json": {
            generatedAt: new Date().toISOString(),
            flow: "resume live FA-EX1 worker DAG",
            runId: run.runId,
            runState: run.state,
            profileId: agents.profileId ?? null,
            agents: agents.agents.map((agent) => ({
              nodeId: agent.nodeId,
              role: agent.role,
              status: agent.status,
            })),
          },
        },
      );
      return;
    }
    const task = goldenTask("golden/node-backend/bug");
    expect(promptLeaksOracle(task.prompt)).toBe(false);
    const materialized = materializeGoldenRepo("node-backend");
    try {
      expect(workspaceOracleLeaks(materialized.root)).toEqual([]);
      const result = await runGoldenProductionTrial({
        task,
        materialized,
        world: opened.world,
        drainRunner: () =>
          drainHostRunnerUntilIdle({
            client: opened.runner,
            runnerId: opened.runnerId,
            capabilitiesObjectDigest: opened.capabilitiesObjectDigest,
            workspaceRootById: { [opened.world.workspaceId]: materialized.root },
            maxJobs: 16,
          }),
        settle: ({ runId, broker }) => waitForLiveFastDag({ broker, runId }),
      });
      expect(result.pi.notifications.some((line) => line.startsWith("HEC started run_"))).toBe(true);
      expect(result.broker.lastError).toBeUndefined();
      expect(result.run.runId).toMatch(/^run_/);
      expect(result.runnerDrained).toBe(1);
      expect(result.run.state).not.toBe("CREATED");
      expect(result.run.state).not.toBe("SNAPSHOT_REQUESTED");
      expect(result.run.state).not.toBe("PREFLIGHT_COMPLETE");
      expect(result.run.state).not.toBe("PROFILE_RUNNING");
      expect(liveFastDagReachedOutcome(result.run.state)).toBe(true);
      const agents = result.broker.lastAgents;
      expect(agents).toBeDefined();
      if (agents === undefined) {
        throw new Error("live FAST DAG agents missing");
      }
      expect(agents.agents.length).toBeGreaterThan(0);
      process.stdout.write(
        `FAEX1_LIVE_GOLDEN_RUN=${result.run.runId} STATE=${result.run.state} PROFILE=${agents.profileId ?? "-"} INTENT=${agents.composition?.primaryIntent ?? "-"} OVERLAYS=${(agents.composition?.overlays ?? []).join(",") || "-"} BUDGET=${agents.composition?.executionBudget ?? "-"} AGENTS=${agents.agents.map((agent) => `${agent.role}:${agent.status}`).join(",")}\n`,
      );
      const headline = aggregateGoldenMetrics([result.trial]);
      await writeLocalReports(
        path.join(fileURLToPath(new URL("../../../../test/evaluation/reports/generated", import.meta.url))),
        {
          "golden-production-live.json": {
            generatedAt: new Date().toISOString(),
            flow: "live /hec + FA-EX1 host snapshot runner + live worker FAST DAG",
            runId: result.run.runId,
            runState: result.run.state,
            profileId: agents.profileId ?? null,
            compiledProfileDigest: agents.compiledProfileDigest ?? null,
            composition: agents.composition ?? null,
            agents: agents.agents.map((agent) => ({
              nodeId: agent.nodeId,
              role: agent.role,
              status: agent.status,
            })),
            drained: result.drained,
            runnerDrained: result.runnerDrained,
            recovered: result.recovered,
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
      rmSync(materialized.root, { recursive: true, force: true });
    }
  },
);
