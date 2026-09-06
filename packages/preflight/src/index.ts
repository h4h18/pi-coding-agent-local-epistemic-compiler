export const packageName = "@pi-hec/preflight";

export {
  EVIDENCE_COMPILER_SYSTEM_PROMPT,
  assertExactEvidenceToolNames,
  createControlledResourceLoader,
  createLocalAnalystSession,
  createLocalSemanticAdapter,
  measureSessionInventory,
} from "./local-session.js";
export type {
  LocalAnalystSession,
  LocalAnalystSessionInput,
  LocalSemanticAdapter,
  LocalSemanticAdapterInput,
} from "./local-session.js";
export {
  createEvidenceTools,
  createEvidenceToolSpecs,
  evidenceToolSpec,
} from "./tools/evidence-tools.js";
export type {
  EvidenceProposalSink,
  EvidenceToolDependencies,
  EvidenceToolName,
  EvidenceToolOutput,
  EvidenceToolSpec,
} from "./tools/evidence-tools.js";
export {
  LOCAL_TEXT_TAINT_MARKER,
  persistAnalystTrace,
  sanitizeLocalText,
  scanAnalystText,
} from "./tools/scanner.js";
export type { AnalystScan, AnalystTrace, PromotionSinks } from "./tools/scanner.js";
export { assertSnapshotPrefix, assertSnapshotRelativePath } from "./tools/snapshot-path.js";
export { EvidenceToolResultSchema, emptyToolResult } from "./tools/results.js";
export type { EvidenceToolResult } from "./tools/results.js";
export { runAdaptivePreflight, seedGraph } from "./orchestrator.js";
export type {
  PreflightInput,
  PreflightResult,
  PreflightTask,
  PreflightResourceLimits,
} from "./orchestrator.js";
export { actionPriority, paretoFrontier, upperConfidenceBound } from "./scheduler.js";
export { auditStability, compileCriticalFacets, graphWithoutChannel } from "./stability.js";
export {
  CLOSURE_STATES,
  CLOSURE_TEMPLATES,
  buildClosureReport,
  closureReportDigest,
  deterministicSeed,
  evaluateClosureState,
  predicatesFor,
} from "./closure/index.js";
export type {
  ClosureState,
  ClosureTemplate,
  PreflightRequirement,
  SeedInstruction,
} from "./closure/index.js";
export { ANALYST_LANES, reconstructAction } from "./actions.js";
