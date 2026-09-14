import type { RunId, RunProjection } from "@pi-hec/contracts";
import type { ControlPlaneBroker } from "./control-broker.js";
import {
  DEFAULT_LIVE_FAST_DAG_POLL_MS,
  liveFastDagStillRunning,
  liveFastDagTimeoutMs,
} from "./live-fast-dag.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pollRun(broker: ControlPlaneBroker, runId: RunId): Promise<RunProjection> {
  const status = await broker.request({
    requestId: "live-fast-dag-status",
    method: "GET_RUN_STATUS",
    params: { runId },
  });
  switch (status.outcome) {
    case "RUN":
      return status.run;
    case "ERROR":
      throw new Error(status.error.message);
    case "EVENTS":
    case "OPERATION_ACCEPTED":
    case "TRUSTED_UI_OPENED":
    case "AGENTS":
      throw new Error(`unexpected GET_RUN_STATUS outcome ${status.outcome}`);
    default: {
      const exhaustive: never = status;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function pollAgents(broker: ControlPlaneBroker, runId: RunId): Promise<void> {
  const listed = await broker.request({
    requestId: "live-fast-dag-agents",
    method: "LIST_AGENTS",
    params: { runId },
  });
  switch (listed.outcome) {
    case "AGENTS":
      return;
    case "ERROR":
      throw new Error(listed.error.message);
    case "RUN":
    case "EVENTS":
    case "OPERATION_ACCEPTED":
    case "TRUSTED_UI_OPENED":
      throw new Error(`unexpected LIST_AGENTS outcome ${listed.outcome}`);
    default: {
      const exhaustive: never = listed;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function agentSummary(broker: ControlPlaneBroker): string {
  const page = broker.lastAgents;
  if (page === undefined) {
    return "profile=- agents=-";
  }
  const profile = page.profileId ?? "-";
  const agents =
    page.agents.length === 0
      ? "-"
      : page.agents.map((agent) => `${agent.nodeId}:${agent.status}`).join(",");
  return `profile=${profile} agents=${agents}`;
}

export async function waitForLiveFastDag(input: {
  readonly broker: ControlPlaneBroker;
  readonly runId: RunId;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}): Promise<RunProjection> {
  const timeoutMs = input.timeoutMs ?? liveFastDagTimeoutMs();
  const pollMs = input.pollMs ?? DEFAULT_LIVE_FAST_DAG_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastLogged = "";
  for (;;) {
    const run = await pollRun(input.broker, input.runId);
    await pollAgents(input.broker, input.runId);
    const line = `FAEX1_LIVE_FAST_DAG state=${run.state} ${agentSummary(input.broker)}`;
    if (lastLogged !== line) {
      lastLogged = line;
      process.stdout.write(`${line}\n`);
    }
    if (!liveFastDagStillRunning(run.state)) {
      return run;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `live FA-EX1 worker FAST DAG still ${run.state} after ${String(timeoutMs)}ms (${agentSummary(input.broker)})`,
      );
    }
    await sleep(pollMs);
  }
}
