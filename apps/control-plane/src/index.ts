export const packageName = "@pi-hec/control-plane";

export { buildApp, listenControlPlane } from "./app.js";
export type { ListeningControlPlane } from "./app.js";
export { recoverOperations } from "./orchestration/recovery.js";
export type { RecoveryReport } from "./orchestration/recovery.js";
export { Scheduler } from "./orchestration/scheduler.js";
export { persistDomainEvent } from "./orchestration/reducer.js";
export {
  BLOB_BODY_LIMIT,
  DEFAULT_LEASE_WAIT_MS,
  JSON_BODY_LIMIT,
  nowIso,
} from "./config.js";
export type { ControlPlaneConfig, TlsFiles } from "./config.js";
export { ProjectListingIdentityStore } from "./orchestration/handlers.js";
export type { AppContext, RegistryRoute } from "./orchestration/handlers.js";
export {
  buildContextDelta,
  handleContextFallback,
  handleRepairAfterVerdict,
  isUnboundedContextRequest,
  newCloudCallId,
} from "./services/context-jobs.js";
export { recordApplyReceipt } from "./services/promotion.js";
export { enqueueVerificationOperation } from "./services/verification-jobs.js";
export type { VerificationOperationKind } from "./services/verification-jobs.js";
export type {
  ContextFallbackInput,
  ContextFallbackResult,
  ContextFollowUpDispatch,
  RepairCompileDispatch,
  RepairOrchestrationInput,
  RepairOrchestrationResult,
  RetrievedContextEvidence,
} from "./services/context-jobs.js";
