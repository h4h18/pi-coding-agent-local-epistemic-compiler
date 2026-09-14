import { Compile } from "typebox/compile";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  AcceptanceLedgerSchema,
  ApplyReceiptSchema,
  ApprovalGrantSchema,
  BaselineSealSchema,
  CandidateManifestSchema,
  ChangeManifestSchema,
  ChangeSetSchema,
  ClosureReportSchema,
  EnvironmentSealSchema,
  EvidenceGraphSchema,
  InstructionManifestSchema,
  RequirementLedgerSchema,
  ReviewFindingsSchema,
  SkillManifestSchema,
  SnapshotManifestSchema,
  SuccessfulRunResultSchema,
  TaskContractSchema,
  TaskEnvelopeSchema,
  VerdictReportSchema,
  VerificationPlanSchema,
  WorkflowProfileSchema,
  CompiledProfileSchema,
  RunCompositionSchema,
  RelatedRunPlanSchema,
  ProjectAdapterSchema,
  asCheckId,
  asObligationId,
  asObjectDigest,
  asRequirementId,
  asRunId,
  asSnapshotId,
  canonicalizeRfc8785,
  isObjectDigest,
  isRunId,
  isSnapshotId,
  objectDigestFromBytes,
  randomPrefixedUuidV7,
  sha256HexToCrockford32,
  sha256Utf8,
  toJsonValue,
  type ApplyReceipt,
  type ApprovalGrant,
  type BaselineSeal,
  type CandidateManifest,
  type ChangeManifest,
  type ChangeSet,
  type ClosureReport,
  type EnvironmentSeal,
  type EvidenceGraph,
  type InstructionManifest,
  type ObjectDigest,
  type PrincipalScope,
  type RequirementLedger,
  type ReviewFindings,
  type RunGuardId,
  type RunProjection,
  type RunState,
  type SkillManifest,
  type SnapshotId,
  type SnapshotManifest,
  type SuccessfulRunResult,
  type TaskContract,
  type TaskEnvelope,
  type VerdictReport,
  type VerificationPlan,
  type WorkflowProfile,
  type CheckNode,
  type ProofObligation,
  type ProjectAdapter,
} from "@pi-hec/contracts";
import {
  DEFAULT_AGENT_OVERLAY_ROOT,
  overlayPathFor,
} from "@pi-hec/agent-runtime";
import {
  compileAcceptanceLedger,
  definitionOfDoneSatisfied,
  enterStateEvent,
  findProjectAdapterSnapshotEntry,
  isRunState,
  lockProjectAdapter,
  lockProjectAdapterFromDocument,
  resolvedVerificationPacks,
  workflowProfileById,
  type VerifiedArtifactSet,
} from "@pi-hec/domain";
import {
  jsonBuffer,
  newOperationId,
  persistCasArtifact,
  type AppContext,
} from "./handlers.js";
import {
  isProfileId,
  asProfileId,
  loadPersistedCompiledProfile,
  PROFILE_BINDING_NODE,
  PREDICATES_NODE,
} from "../services/profile-runner.js";
import { isAgentDagIdle, isAgentDagUnrecoverable } from "../services/agent-jobs.js";

const TASK_ENVELOPE = Compile(TaskEnvelopeSchema);
const TASK_CONTRACT = Compile(TaskContractSchema);
const REQUIREMENT_LEDGER = Compile(RequirementLedgerSchema);
const INSTRUCTION_MANIFEST = Compile(InstructionManifestSchema);
const SKILL_MANIFEST = Compile(SkillManifestSchema);
const ENVIRONMENT_SEAL = Compile(EnvironmentSealSchema);
const BASELINE_SEAL = Compile(BaselineSealSchema);
const EVIDENCE_GRAPH = Compile(EvidenceGraphSchema);
const CLOSURE_REPORT = Compile(ClosureReportSchema);
const WORKFLOW_PROFILE = Compile(WorkflowProfileSchema);
const COMPILED_PROFILE = Compile(CompiledProfileSchema);
const RUN_COMPOSITION = Compile(RunCompositionSchema);
const RELATED_RUN_PLAN = Compile(RelatedRunPlanSchema);
const ACCEPTANCE_LEDGER = Compile(AcceptanceLedgerSchema);
const VERDICT_REPORT = Compile(VerdictReportSchema);
const VERIFICATION_PLAN = Compile(VerificationPlanSchema);
const REVIEW_FINDINGS = Compile(ReviewFindingsSchema);
const CHANGE_MANIFEST = Compile(ChangeManifestSchema);
const CHANGE_SET = Compile(ChangeSetSchema);
const CANDIDATE_MANIFEST = Compile(CandidateManifestSchema);
const APPROVAL_GRANT = Compile(ApprovalGrantSchema);
const APPLY_RECEIPT = Compile(ApplyReceiptSchema);
const SUCCESSFUL_RUN_RESULT = Compile(SuccessfulRunResultSchema);
const SNAPSHOT_MANIFEST = Compile(SnapshotManifestSchema);
const PROJECT_ADAPTER = Compile(ProjectAdapterSchema);

const SEAL_TARGETS = [
  "SNAPSHOT_UPLOADING",
  "SNAPSHOT_VALIDATING",
  "SNAPSHOT_READY",
  "INSTRUCTIONS_RESOLVING",
  "INDEXING",
  "BASELINE_PLANNING",
  "BASELINE_VERIFYING",
  "BASELINE_SEALED",
  "PREFLIGHT_RUNNING",
  "PREFLIGHT_COMPLETE",
] as const satisfies readonly RunState[];

type RoleBinding = { role: string; objectDigest: ObjectDigest };

type CaptureSnapshotResult = {
  snapshotId: SnapshotId;
  manifestObjectDigest: ObjectDigest;
  rootDigest: ObjectDigest;
  workspaceRoot: string;
};

function overlayRoot(): string {
  return process.env.PI_HEC_AGENT_OVERLAY_ROOT ?? DEFAULT_AGENT_OVERLAY_ROOT;
}

function laterIso(now: string, ms: number): string {
  return new Date(Date.parse(now) + ms).toISOString();
}

function crockfordId(prefix: "req_" | "obl_" | "check_", seed: string): string {
  return `${prefix}${sha256HexToCrockford32(sha256Utf8(seed).slice("sha256:".length))}`;
}

function posixFrom(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const collected: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === ".git" || entry === "node_modules") {
        continue;
      }
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        visit(full);
        continue;
      }
      if (stat.isFile()) {
        collected.push(full);
      }
    }
  };
  visit(root);
  return collected;
}

function bindingsFrom(run: RunProjection): RoleBinding[] {
  const bindings: RoleBinding[] = [];
  for (const entry of run.artifactRoles) {
    for (const digest of entry.objectDigests) {
      if (!isObjectDigest(digest)) {
        throw new Error("run artifact digest invalid");
      }
      bindings.push({ role: entry.role, objectDigest: asObjectDigest(digest) });
    }
  }
  return bindings;
}

function withRole(bindings: readonly RoleBinding[], role: string, objectDigest: ObjectDigest): RoleBinding[] {
  return [...bindings.filter((binding) => binding.role !== role), { role, objectDigest }];
}

function digestOfRole(bindings: readonly RoleBinding[], role: string): ObjectDigest | undefined {
  return bindings.find((binding) => binding.role === role)?.objectDigest;
}

function requireRole(bindings: readonly RoleBinding[], role: string): ObjectDigest {
  const digest = digestOfRole(bindings, role);
  if (digest === undefined) {
    throw new Error(`missing run artifact role ${role}`);
  }
  return digest;
}

async function readJson(ctx: AppContext, projectId: string, digest: string): Promise<unknown> {
  const bytes = await ctx.cas.getObject({
    projectId,
    objectDigest: asObjectDigest(digest),
  });
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
}

async function persistJson(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  value: unknown,
  schemaName: string | null,
): Promise<ObjectDigest> {
  return persistCasArtifact(
    ctx,
    scope,
    projectId,
    jsonBuffer(value),
    "application/json",
    "internal",
    schemaName,
  );
}

async function persistChecked<T>(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  value: T,
  schemaName: string,
  check: (candidate: unknown) => boolean,
): Promise<ObjectDigest> {
  if (!check(value)) {
    throw new Error(`${schemaName} schema invalid`);
  }
  return persistJson(ctx, scope, projectId, value, schemaName);
}

function artifactsOf(
  bindings: readonly RoleBinding[],
  guards: readonly RunGuardId[] = [],
): VerifiedArtifactSet {
  return {
    bindings,
    signaturesValid: true,
    satisfiedGuards: new Set(guards),
  };
}

async function enterRun(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
  target: RunState,
  bindings: readonly RoleBinding[],
  guards: readonly RunGuardId[] = [],
): Promise<RunProjection> {
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  const current = ctx.store.getRun(projectScope, runId);
  const event = enterStateEvent({
    eventId: randomPrefixedUuidV7("evt_"),
    projectId,
    runId: current.runId,
    expectedStateVersion: current.stateVersion,
    actorType: "control",
    actorId: "control-plane",
    occurredAt: ctx.clock(),
    target,
    reasonCode: "phase",
  });
  const payloadDigest = await persistJson(ctx, scope, projectId, event.payload, "EnterStatePayload");
  try {
    return ctx.store.persistRunEvent(projectScope, {
      event,
      artifacts: artifactsOf(bindings, guards),
      payloadDigest,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`enter ${target} from ${current.state} failed: ${message}`);
  }
}

function parseCaptureResult(value: unknown): CaptureSnapshotResult | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return undefined;
  }
  if (typeof record.snapshotId !== "string" || !isSnapshotId(record.snapshotId)) {
    return undefined;
  }
  if (typeof record.manifestObjectDigest !== "string" || !isObjectDigest(record.manifestObjectDigest)) {
    return undefined;
  }
  if (typeof record.rootDigest !== "string" || !isObjectDigest(record.rootDigest)) {
    return undefined;
  }
  if (typeof record.workspaceRoot !== "string" || record.workspaceRoot.length === 0) {
    return undefined;
  }
  return {
    snapshotId: asSnapshotId(record.snapshotId),
    manifestObjectDigest: asObjectDigest(record.manifestObjectDigest),
    rootDigest: asObjectDigest(record.rootDigest),
    workspaceRoot: record.workspaceRoot,
  };
}

async function loadCaptureResult(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
): Promise<CaptureSnapshotResult | undefined> {
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  const captured = ctx.store
    .listOperations(projectScope)
    .filter(
      (operation) =>
        operation.runId === runId &&
        operation.operationKind === "CAPTURE_SNAPSHOT" &&
        operation.state === "succeeded" &&
        operation.resultDigest !== undefined,
    )
    .at(-1);
  if (captured?.resultDigest === undefined) {
    return undefined;
  }
  return parseCaptureResult(await readJson(ctx, projectId, captured.resultDigest));
}

async function loadTaskEnvelope(
  ctx: AppContext,
  projectId: string,
  bindings: readonly RoleBinding[],
): Promise<TaskEnvelope> {
  const digest = requireRole(bindings, "task-envelope");
  const parsed = await readJson(ctx, projectId, digest);
  if (!TASK_ENVELOPE.Check(parsed)) {
    throw new Error("task envelope schema invalid");
  }
  return parsed;
}

async function loadSnapshotManifest(
  ctx: AppContext,
  projectId: string,
  digest: ObjectDigest,
): Promise<SnapshotManifest> {
  const parsed = await readJson(ctx, projectId, digest);
  if (!SNAPSHOT_MANIFEST.Check(parsed)) {
    throw new Error("snapshot manifest schema invalid");
  }
  return parsed;
}

async function persistTypedSnapshotManifest(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  capture: CaptureSnapshotResult,
): Promise<ObjectDigest> {
  const manifest = await loadSnapshotManifest(ctx, projectId, capture.manifestObjectDigest);
  if (manifest.snapshotId !== capture.snapshotId || manifest.rootDigest !== capture.rootDigest) {
    throw new Error("capture result does not match snapshot manifest");
  }
  const digest = await persistCasArtifact(
    ctx,
    scope,
    projectId,
    Buffer.from(canonicalizeRfc8785(toJsonValue(manifest)), "utf8"),
    "application/json",
    "internal",
    "SnapshotManifest",
  );
  const recorded = ctx.store.getArtifact(ctx.store.toProjectScope(scope, projectId), digest);
  if (recorded?.schemaName !== "SnapshotManifest") {
    throw new Error("snapshot-manifest catalog schema missing");
  }
  return digest;
}

async function readSnapshotFileBytes(
  ctx: AppContext,
  projectId: string,
  entry: Extract<SnapshotManifest["entries"][number], { entryType: "file" }>,
): Promise<Buffer> {
  switch (entry.storage.kind) {
    case "blob": {
      if (!isObjectDigest(entry.storage.objectDigest)) {
        throw new Error("snapshot blob digest invalid");
      }
      const bytes = await ctx.cas.getObject({
        projectId,
        objectDigest: asObjectDigest(entry.storage.objectDigest),
      });
      return Buffer.from(bytes);
    }
    case "chunks": {
      const parts: Buffer[] = [];
      for (const chunk of entry.storage.chunks) {
        if (!isObjectDigest(chunk.digest)) {
          throw new Error("snapshot chunk digest invalid");
        }
        const bytes = await ctx.cas.getObject({
          projectId,
          objectDigest: asObjectDigest(chunk.digest),
        });
        parts.push(Buffer.from(bytes));
      }
      return Buffer.concat(parts);
    }
    default: {
      const exhaustive: never = entry.storage;
      throw new Error(`unhandled snapshot storage ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function lockAdapterFromSnapshot(
  ctx: AppContext,
  projectId: string,
  manifest: SnapshotManifest,
): Promise<ProjectAdapter> {
  const entry = findProjectAdapterSnapshotEntry(manifest.entries);
  if (entry === undefined) {
    return lockProjectAdapter(undefined).adapter;
  }
  const bytes = await readSnapshotFileBytes(ctx, projectId, entry);
  return lockProjectAdapterFromDocument(bytes.toString("utf8")).adapter;
}

async function adapterFromRunBindings(
  ctx: AppContext,
  projectId: string,
  bindings: readonly RoleBinding[],
): Promise<ProjectAdapter> {
  const digest = digestOfRole(bindings, "project-lock");
  if (digest === undefined) {
    return lockProjectAdapter(undefined).adapter;
  }
  return lockProjectAdapter(await readJson(ctx, projectId, digest)).adapter;
}

function ensureSnapshotRow(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
  capture: CaptureSnapshotResult,
  manifestDigest: ObjectDigest,
): void {
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  const run = ctx.store.getRun(projectScope, runId);
  const existing = ctx.store.findSnapshotByRootDigest(
    projectScope,
    run.workspaceId,
    capture.rootDigest,
  );
  if (existing !== undefined) {
    try {
      ctx.store.bindSnapshotArtifact(projectScope, {
        snapshotId: existing.snapshotId,
        role: "snapshot-manifest",
        artifactDigest: manifestDigest,
        createdAt: ctx.clock(),
      });
    } catch {
      ctx.store.getSnapshot(projectScope, existing.snapshotId);
    }
    return;
  }
  ctx.store.createSnapshot(projectScope, {
    snapshotId: capture.snapshotId,
    workspaceId: run.workspaceId,
    rootDigest: capture.rootDigest,
    manifestDigest,
    runnerId: ctx.store.getWorkspace(projectScope, run.workspaceId).runnerId,
    createdAt: ctx.clock(),
  });
}

function nodeArtifactDigest(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
  nodeId: string,
): string | undefined {
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  return ctx.store.listAgentNodes(projectScope, runId).find((node) => node.nodeId === nodeId)
    ?.artifactDigest;
}

async function loadOptionalSchema<T>(
  ctx: AppContext,
  projectId: string,
  digest: string | undefined,
  check: (value: unknown) => value is T,
): Promise<T | undefined> {
  if (digest === undefined || !isObjectDigest(digest)) {
    return undefined;
  }
  const parsed = await readJson(ctx, projectId, digest);
  return check(parsed) ? parsed : undefined;
}

function environmentSeal(): EnvironmentSeal {
  const seal: EnvironmentSeal = {
    schemaVersion: 1,
    os: process.platform,
    architecture: process.arch,
    toolchains: {},
    dependencyLockObjectDigests: [],
    locale: "C",
    timezone: "UTC",
    fontObjectDigests: [],
    browserBuildObjectDigests: [],
    deviceProfileObjectDigests: [],
    secretHandles: [],
    externalParameters: {},
  };
  if (!ENVIRONMENT_SEAL.Check(seal)) {
    throw new Error("environment seal schema invalid");
  }
  return seal;
}

function instructionManifest(snapshotId: SnapshotId): InstructionManifest {
  const manifest: InstructionManifest = {
    schemaVersion: 1,
    snapshotId,
    instructions: [],
  };
  if (!INSTRUCTION_MANIFEST.Check(manifest)) {
    throw new Error("instruction manifest schema invalid");
  }
  return manifest;
}

function skillManifest(snapshotId: SnapshotId): SkillManifest {
  const manifest: SkillManifest = {
    schemaVersion: 1,
    snapshotId,
    skills: [],
    conflicts: [],
  };
  if (!SKILL_MANIFEST.Check(manifest)) {
    throw new Error("skill manifest schema invalid");
  }
  return manifest;
}

function emptyGraph(snapshotId: SnapshotId): EvidenceGraph {
  const graph: EvidenceGraph = { schemaVersion: 1, snapshotId, nodes: [], edges: [] };
  if (!EVIDENCE_GRAPH.Check(graph)) {
    throw new Error("evidence graph schema invalid");
  }
  return graph;
}

function requirementLedger(runId: string, task: TaskEnvelope): RequirementLedger {
  const text = task.originalRequest;
  const ledger: RequirementLedger = {
    schemaVersion: 1,
    runId: asRunId(runId),
    originalRequest: text,
    originalRequestDigest: task.originalRequestDigest,
    requirements: [
      {
        id: asRequirementId(crockfordId("req_", `${runId}:${text}`)),
        text,
        sourceRefs: [],
        priority: "MUST",
        state: "CLEAR",
        kind: "authoritative",
        source: "USER_EXPLICIT",
        normative: true,
      },
    ],
    nonGoals: [],
    conflicts: [],
    openQuestions: [],
  };
  if (!REQUIREMENT_LEDGER.Check(ledger)) {
    throw new Error("requirement ledger schema invalid");
  }
  return ledger;
}

async function persistSealedArtifacts(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  run: RunProjection,
  capture: CaptureSnapshotResult,
): Promise<RoleBinding[]> {
  const now = ctx.clock();
  const manifestDigest = await persistTypedSnapshotManifest(ctx, scope, projectId, capture);
  let bindings = withRole(bindingsFrom(run), "snapshot-manifest", manifestDigest);
  const manifest = await loadSnapshotManifest(ctx, projectId, capture.manifestObjectDigest);
  const adapter = await lockAdapterFromSnapshot(ctx, projectId, manifest);
  const lockDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    adapter,
    "ProjectAdapter",
    (value) => PROJECT_ADAPTER.Check(value),
  );
  bindings = withRole(bindings, "project-lock", lockDigest);
  const task = await loadTaskEnvelope(ctx, projectId, bindings);
  const ledger = requirementLedger(run.runId, task);
  const ledgerDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    ledger,
    "RequirementLedger",
    (value) => REQUIREMENT_LEDGER.Check(value),
  );
  bindings = withRole(bindings, "requirement-ledger", ledgerDigest);
  const instructions = instructionManifest(capture.snapshotId);
  const instructionDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    instructions,
    "InstructionManifest",
    (value) => INSTRUCTION_MANIFEST.Check(value),
  );
  bindings = withRole(bindings, "instruction-manifest", instructionDigest);
  const skills = skillManifest(capture.snapshotId);
  const skillDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    skills,
    "SkillManifest",
    (value) => SKILL_MANIFEST.Check(value),
  );
  bindings = withRole(bindings, "skill-manifest", skillDigest);
  const env = environmentSeal();
  const envDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    env,
    "EnvironmentSeal",
    (value) => ENVIRONMENT_SEAL.Check(value),
  );
  bindings = withRole(bindings, "environment-seal", envDigest);
  const commandPlanDigest = await persistJson(ctx, scope, projectId, { schemaVersion: 1, commands: [] }, null);
  const exclusionDigest = await persistJson(ctx, scope, projectId, { schemaVersion: 1, excluded: [] }, null);
  const verifierDigest = await persistJson(ctx, scope, projectId, { schemaVersion: 1, verifiers: [] }, null);
  const evidenceRoot = await persistJson(
    ctx,
    scope,
    projectId,
    { schemaVersion: 1, kind: "baseline-evidence-root" },
    null,
  );
  const baseline: BaselineSeal = {
    schemaVersion: 1,
    runId: run.runId,
    taskEnvelopeObjectDigest: requireRole(bindings, "task-envelope"),
    snapshotId: capture.snapshotId,
    snapshotRootDigest: capture.rootDigest,
    instructionManifestObjectDigest: instructionDigest,
    skillManifestObjectDigest: skillDigest,
    environmentSealObjectDigest: envDigest,
    commandPlanObjectDigest: commandPlanDigest,
    baselineEvidenceRootDigest: evidenceRoot,
    exclusionManifestObjectDigest: exclusionDigest,
    verifierManifestObjectDigest: verifierDigest,
    createdAt: now,
  };
  const baselineDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    baseline,
    "BaselineSeal",
    (value) => BASELINE_SEAL.Check(value),
  );
  bindings = withRole(bindings, "baseline-seal", baselineDigest);
  const graph = emptyGraph(capture.snapshotId);
  const graphDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    graph,
    "EvidenceGraph",
    (value) => EVIDENCE_GRAPH.Check(value),
  );
  bindings = withRole(bindings, "evidence-graph", graphDigest);
  const stabilityDigest = await persistJson(
    ctx,
    scope,
    projectId,
    { schemaVersion: 1, kind: "stability-audit" },
    null,
  );
  const closure: ClosureReport = {
    schemaVersion: 1,
    runId: run.runId,
    snapshotId: capture.snapshotId,
    state: "COMPLETE",
    evidenceGraphObjectDigest: graphDigest,
    requirementWitnesses: ledger.requirements.map((requirement) => ({
      requirementId: requirement.id,
      bundleIds: [],
      status: "covered" as const,
    })),
    unresolvedCriticalEvidenceIds: [],
    exhaustedActionDigests: [],
    stabilityAuditObjectDigest: stabilityDigest,
  };
  const closureDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    closure,
    "ClosureReport",
    (value) => CLOSURE_REPORT.Check(value),
  );
  return withRole(bindings, "closure-report", closureDigest);
}

function bindingsForSealTarget(
  sealed: readonly RoleBinding[],
  target: (typeof SEAL_TARGETS)[number],
): RoleBinding[] {
  const roles: readonly string[] =
    target === "SNAPSHOT_UPLOADING" || target === "SNAPSHOT_VALIDATING"
      ? ["task-envelope"]
      : target === "SNAPSHOT_READY" ||
          target === "INSTRUCTIONS_RESOLVING" ||
          target === "INDEXING" ||
          target === "BASELINE_PLANNING" ||
          target === "BASELINE_VERIFYING"
        ? ["task-envelope", "snapshot-manifest", "project-lock"]
        : target === "BASELINE_SEALED"
          ? [
              "task-envelope",
              "snapshot-manifest",
              "project-lock",
              "requirement-ledger",
              "instruction-manifest",
              "skill-manifest",
              "environment-seal",
              "baseline-seal",
            ]
          : target === "PREFLIGHT_RUNNING"
            ? [
                "task-envelope",
                "snapshot-manifest",
                "project-lock",
                "requirement-ledger",
                "instruction-manifest",
                "skill-manifest",
                "environment-seal",
                "baseline-seal",
                "evidence-graph",
              ]
            : [
                "task-envelope",
                "snapshot-manifest",
                "project-lock",
                "requirement-ledger",
                "instruction-manifest",
                "skill-manifest",
                "environment-seal",
                "baseline-seal",
                "evidence-graph",
                "closure-report",
              ];
  return sealed.filter((binding) => roles.includes(binding.role));
}

async function walkToPreflightComplete(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
  sealed: readonly RoleBinding[],
): Promise<RunProjection> {
  let run = ctx.store.getRun(ctx.store.toProjectScope(scope, projectId), runId);
  for (const target of SEAL_TARGETS) {
    if (run.state === target) {
      continue;
    }
    const guards: RunGuardId[] =
      target === "BASELINE_VERIFYING" ? ["APPROVAL_VALID_AND_CONSUMED"] : [];
    run = await enterRun(
      ctx,
      scope,
      projectId,
      runId,
      target,
      bindingsForSealTarget(sealed, target),
      guards,
    );
  }
  return run;
}

function obligationKindOf(raw: string): ProofObligation["kind"] {
  switch (raw) {
    case "FUNCTIONAL":
    case "BUILD":
    case "STATIC_ANALYSIS":
    case "REPRODUCTION":
    case "SECURITY":
    case "PERFORMANCE":
    case "SOURCE_COMPATIBILITY":
    case "WIRE_COMPATIBILITY":
    case "ABI_COMPATIBILITY":
    case "SCHEMA_COMPATIBILITY":
    case "DATA_MIGRATION":
    case "VISUAL":
    case "ACCESSIBILITY":
    case "BROWSER_INTERACTION":
    case "MOBILE_LIFECYCLE":
    case "PLATFORM_MATRIX":
    case "EVIDENCE_INTEGRITY":
      return raw;
    default:
      return "FUNCTIONAL";
  }
}

function verificationFromCompiled(
  profile: WorkflowProfile,
  adapter: ProjectAdapter,
): { obligations: ProofObligation[]; checks: CheckNode[] } {
  if (profile.schemaVersion !== 2) {
    return { obligations: [], checks: [] };
  }
  const packs = resolvedVerificationPacks(profile.composition, adapter);
  const obligations: ProofObligation[] = [];
  const checks: CheckNode[] = [];
  for (const pack of packs) {
    const kinds =
      pack.commands.obligationKinds.length === 0 ? ["FUNCTIONAL"] : pack.commands.obligationKinds;
    for (const [index, kind] of kinds.entries()) {
      const obligationId = asObligationId(crockfordId("obl_", `${pack.id}:${kind}:${String(index)}`));
      obligations.push({
        id: obligationId,
        requirementIds: [],
        claim: `pack ${pack.id} ${kind}`,
        claimMode: "NON_REGRESSION",
        kind: obligationKindOf(kind),
        mandatory: true,
        sourceRefs: [],
        prerequisites: [],
      });
    }
    for (const [index, command] of pack.commands.commands.entries()) {
      const obligationId = obligations[Math.min(index, Math.max(obligations.length - 1, 0))]?.id;
      checks.push({
        id: asCheckId(crockfordId("check_", `${pack.id}:${command.id}:${String(index)}`)),
        obligationIds: obligationId === undefined ? [] : [obligationId],
        subject: pack.commands.phase === "baseline" ? "BASELINE" : "CANDIDATE",
        recipe: command,
        dependencies: [],
        mandatory: true,
        approval: "AUTO",
      });
    }
  }
  return { obligations, checks };
}

function selectedProfile(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
): WorkflowProfile | undefined {
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  const compiled = loadPersistedCompiledProfile(ctx.store, projectScope, runId);
  if (compiled !== undefined) {
    return compiled;
  }
  const binding = ctx.store
    .listAgentNodes(projectScope, runId)
    .find((node) => node.nodeId === PROFILE_BINDING_NODE);
  if (binding?.operation === undefined || !isProfileId(binding.operation)) {
    return undefined;
  }
  return workflowProfileById(asProfileId(binding.operation));
}

async function enterContractedAndRunning(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
): Promise<RunProjection | undefined> {
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  let run = ctx.store.getRun(projectScope, runId);
  const contractDigest = nodeArtifactDigest(ctx, scope, projectId, runId, "analyst");
  if (contractDigest === undefined || !isObjectDigest(contractDigest)) {
    return undefined;
  }
  const contract = await loadOptionalSchema<TaskContract>(
    ctx,
    projectId,
    contractDigest,
    (value): value is TaskContract => TASK_CONTRACT.Check(value),
  );
  if (contract === undefined) {
    return undefined;
  }
  const profile = selectedProfile(ctx, scope, projectId, runId);
  if (profile === undefined) {
    return undefined;
  }
  const compiled = profile.schemaVersion === 2;
  const profileDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    profile,
    "WorkflowProfile",
    (value) =>
      compiled ? COMPILED_PROFILE.Check(value) && WORKFLOW_PROFILE.Check(value) : WORKFLOW_PROFILE.Check(value),
  );
  let bindings = withRole(bindingsFrom(run), "task-contract", asObjectDigest(contractDigest));
  bindings = withRole(bindings, "workflow-profile", profileDigest);
  if (compiled) {
    bindings = withRole(bindings, "compiled-profile", profileDigest);
  }
  if (profile.schemaVersion === 2) {
    const compositionDigest = await persistChecked(
      ctx,
      scope,
      projectId,
      profile.composition,
      "RunComposition",
      (value) => RUN_COMPOSITION.Check(value),
    );
    bindings = withRole(bindings, "run-composition", compositionDigest);
    for (const [index, plan] of (profile.composition.splitIntoRelatedRuns ?? []).entries()) {
      const planDigest = await persistChecked(
        ctx,
        scope,
        projectId,
        plan,
        "RelatedRunPlan",
        (value) => RELATED_RUN_PLAN.Check(value),
      );
      bindings = [
        ...bindings.filter(
          (binding) => binding.role !== "related-run-plan" || binding.objectDigest !== planDigest,
        ),
        { role: "related-run-plan", objectDigest: planDigest },
      ];
      void index;
    }
  }
  if (run.state === "PREFLIGHT_COMPLETE" || run.state === "PREFLIGHT_SATURATED_WITH_UNKNOWNS") {
    run = await enterRun(ctx, scope, projectId, runId, "CONTRACTED", bindings, ["TASK_CONTRACT_VALID"]);
    bindings = bindingsFrom(run);
  }
  if (run.state === "CONTRACTED") {
    run = await enterRun(ctx, scope, projectId, runId, "PROFILE_SELECTED", bindings, [
      "TASK_CONTRACT_VALID",
    ]);
    bindings = bindingsFrom(run);
  }
  if (run.state === "PROFILE_SELECTED") {
    run = await enterRun(ctx, scope, projectId, runId, "PROFILE_RUNNING", bindings, [
      "PROFILE_DAG_BOUND",
    ]);
    bindings = bindingsFrom(run);
  }
  if (run.state === "PROFILE_RUNNING") {
    const predicates =
      ctx.store
        .listAgentNodes(projectScope, runId)
        .find((node) => node.nodeId === PREDICATES_NODE)
        ?.operation?.split(",") ?? [];
    if (predicates.includes("NEED_DESTRUCTIVE_AUTH")) {
      run = await enterRun(ctx, scope, projectId, runId, "AWAITING_REQUIREMENTS_INPUT", bindings);
    } else if (predicates.includes("COMPOSITION_BLOCKED")) {
      run = await enterRun(ctx, scope, projectId, runId, "BLOCKED", bindings);
    }
  }
  return run;
}

function overlayFiles(runId: string): { relative: string; full: string; bytes: Buffer }[] {
  const root = overlayPathFor(overlayRoot(), runId, "implementer");
  return walkFiles(root).map((full) => ({
    relative: posixFrom(root, full),
    full,
    bytes: readFileSync(full),
  }));
}

function localWorkspaceRoot(workspaceRoot: string): boolean {
  try {
    return existsSync(workspaceRoot) && statSync(workspaceRoot).isDirectory();
  } catch {
    return false;
  }
}

function writeOverlayBytes(workspaceRoot: string, files: readonly { relative: string; bytes: Buffer }[]): void {
  for (const file of files) {
    const destination = path.join(workspaceRoot, ...file.relative.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.bytes);
  }
}

async function enterAcceptanceAndTerminal(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
): Promise<RunProjection | undefined> {
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  if (!isAgentDagIdle(ctx.store, projectScope, runId)) {
    return undefined;
  }
  let run = ctx.store.getRun(projectScope, runId);
  if (run.state !== "PROFILE_RUNNING" && run.state !== "ACCEPTANCE_CHECK") {
    return run;
  }
  const capture = await loadCaptureResult(ctx, scope, projectId, runId);
  if (capture === undefined) {
    return run;
  }
  const contractDigest = nodeArtifactDigest(ctx, scope, projectId, runId, "analyst");
  const contract = await loadOptionalSchema<TaskContract>(
    ctx,
    projectId,
    contractDigest,
    (value): value is TaskContract => TASK_CONTRACT.Check(value),
  );
  if (contract === undefined) {
    return run;
  }
  const reviewDigest = nodeArtifactDigest(ctx, scope, projectId, runId, "reviewer");
  const review = await loadOptionalSchema<ReviewFindings>(
    ctx,
    projectId,
    reviewDigest,
    (value): value is ReviewFindings => REVIEW_FINDINGS.Check(value),
  );
  const manifestDigest = nodeArtifactDigest(ctx, scope, projectId, runId, "implementer");
  const changeManifest = await loadOptionalSchema<ChangeManifest>(
    ctx,
    projectId,
    manifestDigest,
    (value): value is ChangeManifest => CHANGE_MANIFEST.Check(value),
  );
  const files = overlayFiles(runId);
  const diffPaths = files.map((file) => file.relative);
  const reviews = review === undefined ? [] : [review];
  const ledger = compileAcceptanceLedger({
    contract,
    contractRevision: 1,
    integrationCommit: changeManifest?.integrationCommit ?? "overlay",
    commandEvidence: [],
    reviewFindings: reviews,
    diffPaths,
    specUpdateSatisfied: !contract.specPolicy.updateRequired,
    blockingFindings: reviews.some((item) => item.blocking),
    preExistingFailures: [],
  });
  const done = definitionOfDoneSatisfied({
    contractValid: true,
    ledger,
    integrationCommit: ledger.integrationCommit,
    baselineCommit: "base",
    outOfScopeChanges: false,
    gatesPassed: ledger.closed,
    blockingFindings: reviews.some((item) => item.blocking),
    freshReviewAfterRepair: true,
    specSatisfied: !contract.specPolicy.updateRequired,
    userTreeUntouched: true,
  });
  if (ctx.store.hasBlockingRelatedRuns(projectScope, runId)) {
    if (run.state === "PROFILE_RUNNING") {
      const blockedLedger = await persistChecked(
        ctx,
        scope,
        projectId,
        ledger,
        "AcceptanceLedger",
        (value) => ACCEPTANCE_LEDGER.Check(value),
      );
      return enterRun(
        ctx,
        scope,
        projectId,
        runId,
        "BLOCKED",
        withRole(bindingsFrom(run), "acceptance-ledger", blockedLedger),
      );
    }
    return run;
  }
  const ledgerDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    ledger,
    "AcceptanceLedger",
    (value) => ACCEPTANCE_LEDGER.Check(value),
  );
  let bindings = withRole(bindingsFrom(run), "acceptance-ledger", ledgerDigest);
  if (run.state === "PROFILE_RUNNING") {
    run = await enterRun(ctx, scope, projectId, runId, "ACCEPTANCE_CHECK", bindings);
    bindings = bindingsFrom(run);
  }
  const baselineDigest = requireRole(bindings, "baseline-seal");
  const compiledForPacks = selectedProfile(ctx, scope, projectId, runId);
  const packed =
    compiledForPacks === undefined
      ? { obligations: [], checks: [] }
      : verificationFromCompiled(
          compiledForPacks,
          await adapterFromRunBindings(ctx, projectId, bindings),
        );
  const plan: VerificationPlan = {
    schemaVersion: 1,
    planId: "plan-multi-agent",
    revision: 1,
    baselineSealObjectDigest: baselineDigest,
    requirements: [],
    obligations: packed.obligations,
    checks: packed.checks,
    baselineSupplementObjectDigests: [],
  };
  const planDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    plan,
    "VerificationPlan",
    (value) => VERIFICATION_PLAN.Check(value),
  );
  const candidateId = randomPrefixedUuidV7("candidate_");
  const callId = randomPrefixedUuidV7("call_");
  const stub = await persistJson(ctx, scope, projectId, { schemaVersion: 1, kind: "eval-stub" }, null);
  const operations = files.map((file) => {
    const after = objectDigestFromBytes(file.bytes);
    const beforeEntry = undefined;
    void beforeEntry;
    return {
      kind: "write_binary" as const,
      path: file.relative,
      expectedBeforeDigest: null,
      mediaType: "application/octet-stream",
      base64Content: file.bytes.toString("base64"),
      expectedAfterDigest: after,
      gitMode: "100644" as const,
    };
  });
  const changeSet: ChangeSet | undefined =
    operations.length === 0
      ? undefined
      : {
          schemaVersion: 1,
          baseSnapshotId: capture.snapshotId,
          baseSnapshotRootDigest: capture.rootDigest,
          operations,
        };
  const changeSetDigest =
    changeSet === undefined
      ? undefined
      : await persistChecked(ctx, scope, projectId, changeSet, "ChangeSet", (value) =>
          CHANGE_SET.Check(value),
        );
  const candidate: CandidateManifest | undefined =
    changeSetDigest === undefined
      ? undefined
      : {
          schemaVersion: 1,
          candidateId,
          runId: run.runId,
          sourceCloudCallId: callId,
          sourceCloudResultObjectDigest: stub,
          requestEnvelopeObjectDigest: stub,
          changeSetObjectDigest: changeSetDigest,
          baseSnapshotId: capture.snapshotId,
          baseSnapshotRootDigest: capture.rootDigest,
          materializedTreeDigest: objectDigestFromBytes(
            Buffer.from(files.map((file) => `${file.relative}:${objectDigestFromBytes(file.bytes)}`).join("\n"), "utf8"),
          ),
          changedPaths: files.map((file) => file.relative),
          materializerVersionObjectDigest: stub,
          createdAt: ctx.clock(),
        };
  const candidateDigest =
    candidate === undefined
      ? stub
      : await persistChecked(ctx, scope, projectId, candidate, "CandidateManifest", (value) =>
          CANDIDATE_MANIFEST.Check(value),
        );
  const accepted = done && ledger.closed && files.length > 0;
  const verdict: VerdictReport = {
    schemaVersion: 1,
    verdict: accepted ? "ACCEPTED" : "REJECTED",
    baselineSealObjectDigest: baselineDigest,
    subject:
      candidate === undefined
        ? {
            kind: "BASELINE_NO_CHANGE",
            snapshotId: capture.snapshotId,
            snapshotRootDigest: capture.rootDigest,
          }
        : { kind: "CHANGESET", candidateManifestObjectDigest: candidateDigest },
    verificationPlanObjectDigest: planDigest,
    obligationResults: [],
    failures: accepted
      ? []
      : [
          {
            code: "acceptance-unproven",
            attribution: "REQUIREMENT",
            repairOwner: "CLOUD",
            certainty: "CONFIRMED",
            obligationIds: [],
            evidenceIds: [],
            failureSignature: sha256Utf8("acceptance-unproven"),
            summary: "acceptance ledger did not close",
          },
        ],
    evidenceRootDigest: requireRole(bindings, "evidence-graph"),
    evidenceAssessments: [],
    workflowState: accepted ? "TERMINAL" : "REPAIRABLE",
  };
  const verdictDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    verdict,
    "VerdictReport",
    (value) => VERDICT_REPORT.Check(value),
  );
  bindings = withRole(bindings, "verification-plan", planDigest);
  bindings = withRole(bindings, "verdict-report", verdictDigest);
  if (run.state === "ACCEPTANCE_CHECK") {
    if (accepted) {
      run = await enterRun(ctx, scope, projectId, runId, "VERIFIED_ACCEPTED", bindings, [
        "ACCEPTANCE_LEDGER_CLOSED",
      ]);
      bindings = bindingsFrom(run);
    } else {
      return enterRun(ctx, scope, projectId, runId, "VERIFIED_REJECTED", bindings);
    }
  }
  if (run.state !== "VERIFIED_ACCEPTED" || candidate === undefined || changeSetDigest === undefined) {
    return run;
  }
  if (!localWorkspaceRoot(capture.workspaceRoot)) {
    return run;
  }
  writeOverlayBytes(capture.workspaceRoot, files);
  const grant: ApprovalGrant = {
    schemaVersion: 1,
    approvalId: randomPrefixedUuidV7("approval_"),
    projectId,
    principalId: scope.principalId,
    challengeObjectDigest: stub,
    approvalDecisionObjectDigest: stub,
    subjectObjectDigest: stub,
    policyObjectDigest: ctx.hostPolicyDigest,
    issuedAt: ctx.clock(),
    expiresAt: laterIso(ctx.clock(), 3_600_000),
    scope: "run",
    runId: run.runId,
    action: "workspace-promotion",
  };
  const grantDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    grant,
    "ApprovalGrant",
    (value) => APPROVAL_GRANT.Check(value),
  );
  bindings = withRole(bindings, "approval-grant", grantDigest);
  run = await enterRun(ctx, scope, projectId, runId, "AWAITING_APPLY_APPROVAL", bindings, [
    "VERDICT_ACCEPTED_CHANGESET",
  ]);
  bindings = bindingsFrom(run);
  run = await enterRun(ctx, scope, projectId, runId, "APPLY_PREPARING", bindings, [
    "SNAPSHOT_ROOT_CURRENT",
    "APPROVAL_VALID_AND_CONSUMED",
  ]);
  bindings = bindingsFrom(run);
  run = await enterRun(ctx, scope, projectId, runId, "APPLYING", bindings, ["APPLY_JOURNAL_VALID"]);
  bindings = bindingsFrom(run);
  const journalDigest = await persistJson(
    ctx,
    scope,
    projectId,
    { schemaVersion: 1, kind: "apply-journal", paths: files.map((file) => file.relative) },
    null,
  );
  const resultingRoot = objectDigestFromBytes(
    Buffer.from(
      files.map((file) => `${file.relative}:${objectDigestFromBytes(file.bytes)}`).join("\n"),
      "utf8",
    ),
  );
  const receipt: ApplyReceipt = {
    schemaVersion: 1,
    runId: run.runId,
    approvalId: grant.approvalId,
    workspaceId: run.workspaceId,
    candidateManifestObjectDigest: candidateDigest,
    baseSnapshotRootDigest: capture.rootDigest,
    changeSetObjectDigest: changeSetDigest,
    journalObjectDigest: journalDigest,
    promotionMode: "ENTRY_JOURNALED",
    affectedPaths: files.map((file) => ({
      path: file.relative,
      beforeDigest: null,
      expectedAfterDigest: objectDigestFromBytes(file.bytes),
      observedAfterDigest: objectDigestFromBytes(file.bytes),
    })),
    completedAt: ctx.clock(),
    outcome: "COMMITTED",
    resultingRootDigest: resultingRoot,
    visibilityGuarantee: "ENTRY_LEVEL",
  };
  const receiptDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    receipt,
    "ApplyReceipt",
    (value) => APPLY_RECEIPT.Check(value),
  );
  bindings = withRole(bindings, "apply-receipt", receiptDigest);
  run = await enterRun(ctx, scope, projectId, runId, "APPLY_RECONCILING", bindings, [
    "APPLY_JOURNAL_VALID",
  ]);
  bindings = bindingsFrom(run);
  const success: SuccessfulRunResult = {
    schemaVersion: 1,
    runId: run.runId,
    kind: "applied",
    candidateManifestObjectDigest: candidateDigest,
    applyReceiptObjectDigest: receiptDigest,
    resultingSnapshotRootDigest: resultingRoot,
  };
  const successDigest = await persistChecked(
    ctx,
    scope,
    projectId,
    success,
    "SuccessfulRunResult",
    (value) => SUCCESSFUL_RUN_RESULT.Check(value),
  );
  bindings = withRole(bindings, "successful-run-result", successDigest);
  return enterRun(ctx, scope, projectId, runId, "SUCCEEDED", bindings, ["APPLY_RECEIPT_COMMITTED"]);
}

export async function requestSnapshotCapture(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
): Promise<void> {
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  let run = ctx.store.getRun(projectScope, runId);
  if (run.state === "CREATED") {
    run = await enterRun(ctx, scope, projectId, runId, "SNAPSHOT_REQUESTED", bindingsFrom(run));
  }
  const inputDigest = await persistJson(
    ctx,
    scope,
    projectId,
    { schemaVersion: 1, runId, workspaceId: run.workspaceId },
    null,
  );
  ctx.store.enqueueOperation(projectScope, {
    operationId: newOperationId(),
    runId: asRunId(runId),
    operationKind: "CAPTURE_SNAPSHOT",
    dedupeKey: `CAPTURE_SNAPSHOT:${runId}`,
    inputDigest,
    createdAt: ctx.clock(),
  });
}

export async function ingestCapturedSnapshot(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
): Promise<RunProjection> {
  if ((await loadCaptureResult(ctx, scope, projectId, runId)) === undefined) {
    throw new Error("CAPTURE_SNAPSHOT result missing");
  }
  return advanceRunCompiler(ctx, scope, projectId, runId);
}

export async function advanceRunCompiler(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  runId: string,
): Promise<RunProjection> {
  if (!isRunId(runId)) {
    throw new Error("invalid run id");
  }
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  let run = ctx.store.getRun(projectScope, runId);
  for (let step = 0; step < 64; step += 1) {
    const before = run.state;
    if (
      run.state === "SNAPSHOT_REQUESTED" ||
      run.state === "SNAPSHOT_UPLOADING" ||
      run.state === "SNAPSHOT_VALIDATING"
    ) {
      const capture = await loadCaptureResult(ctx, scope, projectId, runId);
      if (capture === undefined) {
        return run;
      }
      const sealed = await persistSealedArtifacts(ctx, scope, projectId, run, capture);
      ensureSnapshotRow(
        ctx,
        scope,
        projectId,
        runId,
        capture,
        requireRole(sealed, "snapshot-manifest"),
      );
      run = await walkToPreflightComplete(ctx, scope, projectId, runId, sealed);
    } else if (
      run.state === "PREFLIGHT_COMPLETE" ||
      run.state === "PREFLIGHT_SATURATED_WITH_UNKNOWNS" ||
      run.state === "CONTRACTED" ||
      run.state === "PROFILE_SELECTED"
    ) {
      const next = await enterContractedAndRunning(ctx, scope, projectId, runId);
      if (next === undefined) {
        return run;
      }
      run = next;
    } else if (run.state === "PROFILE_RUNNING" || run.state === "ACCEPTANCE_CHECK") {
      if (
        run.state === "PROFILE_RUNNING" &&
        isAgentDagUnrecoverable(ctx.store, projectScope, runId)
      ) {
        run = await enterRun(ctx, scope, projectId, runId, "BLOCKED", bindingsFrom(run));
      } else {
        const next = await enterAcceptanceAndTerminal(ctx, scope, projectId, runId);
        if (next === undefined) {
          return run;
        }
        run = next;
      }
    } else {
      return run;
    }
    if (run.state === before) {
      return run;
    }
  }
  return run;
}

export function mapStoredRunEvents(
  projectId: string,
  events: readonly {
    eventId: string;
    runId: string;
    sequence: number;
    eventType: string;
    actorType: string;
    actorId: string;
    occurredAt: string;
  }[],
) {
  let previousState: RunState = "CREATED";
  return events.map((event) => {
    const suffix = event.eventType.startsWith("ENTER_")
      ? event.eventType.slice("ENTER_".length)
      : "";
    const nextState: RunState = isRunState(suffix) ? suffix : previousState;
    const mapped = {
      schemaVersion: 1 as const,
      eventId: event.eventId,
      eventType: event.eventType,
      projectId,
      runId: event.runId,
      sequence: event.sequence,
      previousState,
      nextState,
      actorType: event.actorType,
      actorId: event.actorId,
      inputArtifactObjectDigests: [] as ObjectDigest[],
      outputArtifactObjectDigests: [] as ObjectDigest[],
      reasonCode: "phase",
      occurredAt: event.occurredAt,
    };
    previousState = nextState;
    return mapped;
  });
}
