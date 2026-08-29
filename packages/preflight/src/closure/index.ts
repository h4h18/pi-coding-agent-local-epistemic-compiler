export { CLOSURE_TEMPLATES, predicatesFor, allTemplatePredicatesPass } from "./templates.js";
export type { ClosureTemplate, ClosurePredicate, ClosurePredicateId } from "./templates.js";
export {
  CLOSURE_STATES,
  resourceLimitHit,
  evaluateWitnesses,
  mandatoryClosurePredicatesPass,
  evaluateClosureState,
  buildClosureReport,
  closureReportDigest,
  digestCanonical,
  requirementHasWitness,
} from "./evaluate.js";
export type {
  ClosureState,
  PreflightRequirement,
  WitnessRecord,
  ClosureEvaluation,
  ResourceLimitSignal,
} from "./evaluate.js";
export { deterministicSeed } from "./seed.js";
export type { SeedInstruction, SeedTask } from "./seed.js";
