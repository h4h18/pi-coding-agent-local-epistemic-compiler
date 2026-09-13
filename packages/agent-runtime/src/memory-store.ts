import type { AgentId } from "@pi-hec/contracts";
import type { AgentHandle, LiveHandleStore } from "./types.js";

export function createMemoryHandleStore(): LiveHandleStore {
  const handles = new Map<AgentId, AgentHandle>();
  return {
    get(agentId) {
      return handles.get(agentId);
    },
    set(handle) {
      handles.set(handle.agentId, handle);
    },
    delete(agentId) {
      handles.delete(agentId);
    },
    list(runId: AgentHandle["runId"]) {
      return [...handles.values()].filter((handle) => handle.runId === runId);
    },
  };
}
