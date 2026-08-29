export const packageName = "@pi-hec/cloud-gateway";

export {
  recoveryForCapabilities,
  recoveryMatchesCapabilities,
  selectDeploymentBeforeDispatch,
} from "./capabilities.js";
export { createOneShotAdapter } from "./dispatcher.js";
export type { OneShotAdapterOptions } from "./dispatcher.js";
export { fsyncReceiptThenComplete, receiptEnvelopeBytes } from "./receipt.js";
export type { CloudCallCompletionPort, ReceiptFsyncPort } from "./receipt.js";
export {
  asObjectDigest,
  buildProviderWireRequest,
  envelopeDigest,
  injectSealedAuthorization,
  isOpenAiShaped,
  providerBodyBytes,
  providerBodyObject,
  providerWireRequestDigestOf,
  unsignedEnvelope,
  wireDispatchBindingsMatch,
} from "./request.js";
export type {
  CapacityWaitingState,
  CredentialInjectResult,
  SealedTokenization,
  WireBuildOk,
  WireBuildResult,
} from "./request.js";
