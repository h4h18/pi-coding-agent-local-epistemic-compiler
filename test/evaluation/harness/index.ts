export { ARM_DEFINITIONS, isProductionGateArm, rejectDiagnosticGateEvidence } from "./arms.js";
export { pairedBootstrap } from "./bootstrap.js";
export {
  runOrdinaryPiBaseline,
  ORDINARY_PI_PACKAGE,
  ORDINARY_PI_VERSION,
} from "./baseline-runner.js";
export { runEvaluationHarness } from "./evaluate.js";
export { FROZEN_ENVIRONMENT, IMMUTABLE_TASKS, taskById } from "./fixtures.js";
export {
  buildHecPacket,
  hecPacketHasEvaluationHints,
  runHecArm,
  HEC_CLOUD_EXECUTOR,
} from "./hec-runner.js";
export {
  countCompletionsFromLedger,
  meanAndP95FromLedger,
  weightedMean,
  weightedP95,
} from "./ledger.js";
export { aggregateMetrics, scoreArm } from "./metrics.js";
export type { AggregatedMetrics, ArmHeadline } from "./metrics.js";
export { decideEligibility, pairTrial } from "./pairing.js";
export { coverageStatus, freezeManifest, HOLDOUT_MIN_PAIRS } from "./protocol.js";
export { claimProductionHoldout, evaluateSection24Gates } from "./section24.js";
export { frozenHoldoutPairs, HOLDOUT_PAIR_COUNT } from "./holdout-corpus.js";
