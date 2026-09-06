export const packageName = "@pi-hec/verification-worker";

export { materializeCandidate } from "./materialize-handler.js";
export type {
  MaterializeCandidateInput,
  MaterializeCandidateResult,
} from "./materialize-handler.js";
export { verifyCandidate } from "./verify-handler.js";
export type { VerifyCandidateInput, VerifyCandidateResult } from "./verify-handler.js";
export { main, startVerificationWorker } from "./main.js";
export type { WorkerPoll } from "./main.js";
