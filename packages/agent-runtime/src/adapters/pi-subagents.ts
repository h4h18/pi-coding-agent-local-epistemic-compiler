import type { AgentRuntime, RuntimeCapabilities, RuntimeSnapshot } from "../types.js";

export type PiSubagentsHandshake = {
  steer: boolean;
  resume: boolean;
  stop: boolean;
  nestedDelegation: boolean;
  fallbackSubagent: string;
  isolationVerified: boolean;
  spawnedFromFaEx1: boolean;
};

export class PiSubagentsRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSubagentsRejectedError";
  }
}

export function assertPiSubagentsHandshake(handshake: PiSubagentsHandshake): void {
  if (!handshake.spawnedFromFaEx1) {
    throw new PiSubagentsRejectedError("pi-subagents is not allowed from Windows Pi");
  }
  if (!handshake.isolationVerified) {
    throw new PiSubagentsRejectedError("worktree parameter is not isolation");
  }
  if (handshake.nestedDelegation) {
    throw new PiSubagentsRejectedError("nestedDelegation must be false");
  }
  if (handshake.fallbackSubagent !== "none") {
    throw new PiSubagentsRejectedError("fallbackSubagent must be none");
  }
  if (!handshake.steer || !handshake.resume || !handshake.stop) {
    throw new PiSubagentsRejectedError("capability handshake missing steer/resume/stop");
  }
}

export function createPiSubagentsRuntimeAdapter(handshake: PiSubagentsHandshake): AgentRuntime {
  assertPiSubagentsHandshake(handshake);
  const capabilities: RuntimeCapabilities = {
    adapter: "pi-subagents",
    version: "rejected-default",
    steer: handshake.steer,
    resume: handshake.resume,
    stop: handshake.stop,
    nestedDelegation: false,
    fallbackSubagent: "none",
  };
  return {
    async capabilities() {
      return capabilities;
    },
    async spawn() {
      throw new PiSubagentsRejectedError("pi-subagents is not the default runtime");
    },
    async consume() {
      throw new PiSubagentsRejectedError("pi-subagents is not the default runtime");
    },
    async steer() {
      throw new PiSubagentsRejectedError("pi-subagents is not the default runtime");
    },
    async stop() {
      throw new PiSubagentsRejectedError("pi-subagents is not the default runtime");
    },
    async reconcile(runId): Promise<RuntimeSnapshot> {
      return { runId, handles: [], nodeStatuses: {} };
    },
  };
}
