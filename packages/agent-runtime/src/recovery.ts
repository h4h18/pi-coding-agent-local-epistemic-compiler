import type { AgentHandle, AgentRuntime, RuntimeSnapshot } from "./types.js";

export type PersistedHandle = AgentHandle & {
  lastHeartbeatAt: string;
  pendingOperation?: string;
};

export function classifyLostHandle(handle: PersistedHandle, live: RuntimeSnapshot): "retry" | "resume" | "drop" {
  const found = live.handles.find((item) => item.agentId === handle.agentId);
  if (found === undefined) {
    return handle.role === "reviewer" ? "retry" : "retry";
  }
  if (handle.role === "reviewer") {
    return "retry";
  }
  return "resume";
}

export async function reconcileHandles(
  runtime: AgentRuntime,
  persisted: readonly PersistedHandle[],
): Promise<{
  live: RuntimeSnapshot;
  retry: readonly PersistedHandle[];
  resume: readonly PersistedHandle[];
}> {
  const first = persisted[0];
  if (first === undefined) {
    return {
      live: { runId: "run_00000000-0000-7000-8000-000000000000" as never, handles: [], nodeStatuses: {} },
      retry: [],
      resume: [],
    };
  }
  const runId = first.runId;
  const live = await runtime.reconcile(runId);
  const retry: PersistedHandle[] = [];
  const resume: PersistedHandle[] = [];
  for (const handle of persisted) {
    const decision = classifyLostHandle(handle, live);
    if (decision === "retry") {
      retry.push(handle);
    } else {
      resume.push(handle);
    }
  }
  return { live, retry, resume };
}
