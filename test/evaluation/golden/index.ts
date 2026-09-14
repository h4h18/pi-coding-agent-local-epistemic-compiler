export { applyEdits, restoreGoldenWorkspace } from "./apply.js";
export { evaluateBehaviors } from "./behaviors.js";
export {
  GOLDEN_TASKS,
  buildCatalog,
  goldenTask,
  materializeGoldenRepo,
  taskIdFor,
} from "./catalog.js";
export {
  ORACLE_LEAK_TOKENS,
  assertWorkspaceConcealed,
  promptLeaksOracle,
  workspaceOracleLeaks,
} from "./concealment.js";
export { compositionForGoldenTask, primaryIntentForGoldenKind } from "./composition.js";
export {
  architecturalDisposition,
  classifiedRunStates,
  isArchitecturalReady,
} from "./disposition.js";
export { aggregateGoldenMetrics, completeTrial, primaryMetric } from "./metrics.js";
export {
  SUITE_ARMS,
  goldenGeneratedReportDir,
  runGoldenSuite,
} from "./suite.js";
export {
  GOLDEN_PROJECT_FOLDER_PREFIX,
  goldenProjectFolderName,
  goldenProjectRoot,
  goldenProjectsParent,
  hooksRepoRoot,
  loadSyncedGoldenProject,
  nestedObservedCwd,
  syncGoldenProject,
  syncGoldenProjects,
} from "./persistent.js";
export type { SyncedGoldenProject } from "./persistent.js";
export { GOLDEN_REPOS, repoDefinition } from "./repos.js";
export { isFalseReady, scoreOracle } from "./score.js";
export { diffTrees, snapshotTree, writeTree } from "./tree.js";
export {
  ARCHITECTURAL_DISPOSITIONS,
  EVIDENCE_KINDS,
  FORBIDDEN_BEHAVIORS,
  GOLDEN_REPO_IDS,
  REQUIRED_BEHAVIORS,
  TASK_KINDS,
} from "./types.js";
export type {
  ArchitecturalDisposition,
  EvidenceKind,
  GoldenHeadline,
  GoldenRepoId,
  GoldenTask,
  GoldenTrialRecord,
  HiddenOracle,
  MaterializedRepo,
  OracleScore,
  TaskKind,
  TrialObservation,
} from "./types.js";
export type {
  ArmReport,
  GoldenConfusion,
  GoldenSuiteReport,
  GoldenTrialSummary,
  SuiteArmId,
} from "./suite.js";
