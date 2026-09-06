export const packageName = "@pi-hec/verification";

export {
  openEvidenceObligationsFromReview,
  scheduleEvidenceFromFindings,
} from "./semantic-review.js";
export type { ScheduleEvidenceInput, SemanticReviewSchedule } from "./semantic-review.js";

export {
  buildRepairPacket,
  isRepairEligible,
  missingIndependentCheckIds,
} from "./repair-packet.js";
export type {
  BuildRepairPacketInput,
  CheckOutcome,
  FailureArtifactInput,
  InlineFailureContent,
  RepairPacketResult,
} from "./repair-packet.js";

export { ChangeSetError, validateAndApplyChangeSet } from "./changeset/index.js";
export type {
  AppliedCandidateTree,
  BaselineEntry,
  BaselineFilesystem,
  ChangeSetBaseline,
} from "./changeset/index.js";

export { compileVerdictReport, decideVerdict, evaluateObligation } from "./verdict.js";
export type { CompileVerdictInput, DecideVerdictInput, ObligationEvaluation } from "./verdict.js";

export {
  PlanError,
  approvalForCommand,
  assertAcyclicPlan,
  assertMonotonic,
  authorityRank,
  bindCommandSpecEnvelope,
  bindResolvedCommandEnvelope,
  buildP0,
  commandSpecContentDigest,
  envelopeDigest,
  mintCheckId,
  mintGeneralId,
  mintObligationId,
  obligationFromRequirement,
  resolveCommandSpec,
  revisePlan,
  signArtifactEnvelope,
  toJsonValue,
  topologicalChecks,
  topologicalObligations,
  verifyArtifactEnvelope,
} from "./plan/index.js";
export type {
  PlanP0Input,
  PlanRevisionDelta,
  RevisePlanInput,
  RevisePlanResult,
  SealedImageIndex,
} from "./plan/index.js";

export {
  createAbiProducer,
  createAndroidProducer,
  createCompilerDiagnosticsProducer,
  createCoverageProducer,
  createFilesystemProducer,
  createGenericProcessProducer,
  collectedTestCount,
  createGraphqlProducer,
  createJunitProducer,
  createLocalSemanticProducer,
  createOpenApiProducer,
  createPlaywrightProducer,
  createProtobufProducer,
  createSarifProducer,
  createSandboxExecutor,
  createSqlMigrationProducer,
  createTapProducer,
  createXcTestProducer,
  findingsFromTask12,
  listingHasMismatch,
  makeEvidenceRecord,
  memoryArtifacts,
  memoryHost,
  networkCapabilityUnavailableExecutor,
  observationSignature,
  openApiKeys,
  parseCobertura,
  parseCompilerDiagnostics,
  parseJunitXml,
  parseLcov,
  parsePlaywrightTrace,
  parseSarif,
  parseSqlMigrations,
  parseTap,
  parseXcResult,
  producerIdsForStdout,
  productionProducers,
  buildSignedSandboxJob,
  executionGate,
} from "./producers/index.js";
export type {
  ArtifactStore,
  EvidenceProducer,
  ProducerBindings,
  ProducerHost,
  SandboxCommandResult,
  SandboxExecutor,
  SandboxJobBinding,
  SandboxJobIdentity,
  SandboxJobSigner,
  SandboxRunInput,
  SignedSandboxCommand,
} from "./producers/index.js";

export {
  ADMISSIBILITY_POLICY,
  FLAKE_STATISTICAL_POLICY,
  admissibleRecords,
  assessAll,
  assessEvidence,
  classifyFlake,
  detectGaming,
  evaluateRedGreen,
  pairedFlake,
  policyRevisionDigest,
  runVerification,
  sprtBounds,
} from "./evidence/index.js";
export type {
  AssessContext,
  EvidenceAssessment,
  FlakeClass,
  GamingFinding,
  RedGreenResult,
  RedGreenTest,
  RunVerificationInput,
  RunVerificationResult,
  TestDiscovery,
} from "./evidence/index.js";
