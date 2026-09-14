import type { RunId, RunProjection, RunState } from "@pi-hec/contracts";
import { FakePi } from "../../../../client/apps/pi-extension/test/harness.js";
import { architecturalDisposition } from "../disposition.js";
import { completeTrial } from "../metrics.js";
import { scoreOracle } from "../score.js";
import type {
  EvidenceKind,
  GoldenTask,
  GoldenTrialRecord,
  MaterializedRepo,
  TrialObservation,
} from "../types.js";
import { ControlPlaneBroker, type ControlPlaneBrokerWorld } from "./control-broker.js";
import { installHumanHec, requireActiveRunId, startTaskAsHuman } from "./hec-terminal.js";

export type ProductionTrialInput = {
  readonly task: GoldenTask;
  readonly materialized: MaterializedRepo;
  readonly world: ControlPlaneBrokerWorld;
  readonly drain?: () => Promise<number>;
  readonly drainRunner?: () => Promise<number>;
  readonly settle?: (input: {
    readonly runId: RunId;
    readonly broker: ControlPlaneBroker;
  }) => Promise<void>;
  readonly recover?: () => Promise<boolean>;
  readonly evidencePresent?: readonly EvidenceKind[];
  readonly cost?: number | null;
};

export type ProductionTrialResult = {
  readonly trial: GoldenTrialRecord;
  readonly run: RunProjection;
  readonly pi: FakePi;
  readonly broker: ControlPlaneBroker;
  readonly drained: number;
  readonly runnerDrained: number;
  readonly recovered: boolean;
};

function observationFromRun(input: {
  readonly run: RunProjection;
  readonly statesVisited: readonly RunState[];
  readonly repairCount: number;
  readonly userInputCount: number;
  readonly recovered: boolean;
  readonly recoveryAttempted: boolean;
  readonly evidencePresent: readonly EvidenceKind[];
  readonly cost: number | null;
  readonly latencyMs: number;
  readonly firstPass: boolean;
}): TrialObservation {
  return {
    declaredDisposition: architecturalDisposition(input.run.state),
    runState: input.run.state,
    runId: input.run.runId,
    statesVisited: input.statesVisited,
    repairCount: input.repairCount,
    userInputCount: input.userInputCount,
    recovered: input.recovered,
    recoveryAttempted: input.recoveryAttempted,
    evidencePresent: input.evidencePresent,
    cost: input.cost,
    latencyMs: input.latencyMs,
    firstPass: input.firstPass,
  };
}

export async function runGoldenProductionTrial(
  input: ProductionTrialInput,
): Promise<ProductionTrialResult> {
  const started = Date.now();
  const pi = new FakePi();
  const broker = new ControlPlaneBroker(input.world);
  installHumanHec({ pi, broker, cwd: input.materialized.root });
  await startTaskAsHuman(pi, input.task.prompt);
  if (broker.lastError !== undefined) {
    throw new Error(broker.lastError.message);
  }
  const runId = requireActiveRunId(pi);
  let drained = 0;
  let runnerDrained = 0;
  if (input.drain !== undefined) {
    drained = await input.drain();
  }
  if (input.drainRunner !== undefined) {
    runnerDrained = await input.drainRunner();
  }
  if (input.settle !== undefined) {
    await input.settle({ runId, broker });
  }
  await pi.runCommand("agents");
  await pi.runCommand("status");
  let recovered = false;
  const recoveryAttempted = input.recover !== undefined;
  if (input.recover !== undefined) {
    recovered = await input.recover();
    await pi.runCommand("recover");
  }
  await pi.runCommand("status");
  const run = broker.lastRun;
  if (run === undefined) {
    throw new Error(`run ${runId} missing after HEC status`);
  }
  const statesVisited: RunState[] = [];
  const events = await broker.request({
    requestId: "eval-events",
    method: "POLL_RUN_EVENTS",
    params: { runId, afterSequence: 0, limit: 200 },
  });
  if (events.outcome === "EVENTS") {
    for (const event of events.page.events) {
      statesVisited.push(event.nextState);
    }
  }
  if (statesVisited.length === 0) {
    statesVisited.push(run.state);
  }
  const evidencePresent = [...(input.evidencePresent ?? [])];
  if (broker.lastAgents !== undefined && broker.lastAgents.agents.length > 0) {
    const roles = new Set(broker.lastAgents.agents.map((agent) => agent.role));
    if (roles.has("investigator")) {
      evidencePresent.push("investigation-report");
    }
    if (roles.has("reviewer")) {
      evidencePresent.push("review-findings");
    }
  }
  const observation = observationFromRun({
    run,
    statesVisited,
    repairCount: 0,
    userInputCount: 0,
    recovered,
    recoveryAttempted,
    evidencePresent: [...new Set(evidencePresent)],
    cost: input.cost ?? null,
    latencyMs: Date.now() - started,
    firstPass: true,
  });
  const score = scoreOracle({
    task: input.task,
    materialized: input.materialized,
    observation,
  });
  return {
    trial: completeTrial(input.task.taskId, input.task.repoId, input.task.kind, observation, score),
    run,
    pi,
    broker,
    drained,
    runnerDrained,
    recovered,
  };
}
