export const packageName = "@pi-hec/agent-runtime";

export {
  assertArtifactAllowed,
  assertToken,
  CapabilityError,
  mintCapabilityToken,
  tokenDigest,
  tokenMac,
} from "./capability.js";
export { assembleWorkerContext, withAgentBinding } from "./context.js";
export { createMemoryHandleStore } from "./memory-store.js";
export {
  cancelBusyInferenceSlots,
  inferenceOriginFromBaseUrl,
  listInferenceSlots,
} from "./inference-slots.js";
export type { CancelBusySlotsResult, InferenceSlot } from "./inference-slots.js";
export {
  DEFAULT_AGENT_OVERLAY_ROOT,
  createDefaultOverlayPorts,
  overlayBranchFor,
  overlayPathFor,
  provisionWorkspaceOverlay,
  reapOverlayProcesses,
  releaseWorkspaceOverlay,
  sweepOrphanOverlays,
} from "./overlay-lifecycle.js";
export type { OverlayPorts, ProvisionWorkspaceOverlayInput, ReleaseWorkspaceOverlayResult } from "./overlay-lifecycle.js";
export {
  abortAndDispose,
  consumeThenStop,
  consumeWithTimeout,
  runTimedAgentTurn,
  DEFAULT_CONSUME_TIMEOUT_MS,
  SESSION_ABORT_TIMEOUT_MS,
  STOP_BEST_EFFORT_MS,
} from "./session-lifecycle.js";
export { assertNoConfusedDeputyTools, createRoleTools, FORBIDDEN_TOOL_NAMES, toolNamesForProfile } from "./tools.js";
export {
  assertCwdInsideLease,
  assertLeaseWritable,
  resolveInsideLease,
  verifyLease,
  WorkspaceIsolationError,
} from "./workspace.js";
export { createControlPlaneSessionAdapter } from "./adapters/control-plane-session.js";
export type { ControlPlaneSessionAdapterOptions } from "./adapters/control-plane-session.js";
export { createDirectProviderLoopAdapter } from "./adapters/direct-provider.js";
export type { DirectProviderLoopOptions, RoleLoopPort, RoleTurn, RoleTurnResult } from "./adapters/direct-provider.js";
export {
  assertPiSubagentsHandshake,
  createPiSubagentsRuntimeAdapter,
  PiSubagentsRejectedError,
} from "./adapters/pi-subagents.js";
export type { PiSubagentsHandshake } from "./adapters/pi-subagents.js";
export { createHeadlessResourceLoader, createPiSdkSessionFactory } from "./pi-session-factory.js";
export type { PiSdkSessionFactoryOptions } from "./pi-session-factory.js";
export { classifyLostHandle, reconcileHandles } from "./recovery.js";
export type { PersistedHandle } from "./recovery.js";
export { advanceDag, profileReadyForAcceptance } from "./orchestrator.js";
export type { OrchestratorPorts, OrchestratorState } from "./orchestrator.js";
export type {
  AgentHandle,
  AgentResult,
  AgentRuntime,
  AssembledContext,
  BridgePorts,
  CommandPorts,
  CustomToolDefinition,
  HeadlessSession,
  LiveHandleStore,
  RuntimeCapabilities,
  RuntimeSnapshot,
  ScopedFsPorts,
  SessionFactory,
} from "./types.js";
