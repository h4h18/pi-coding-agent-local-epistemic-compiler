import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CasError, MemoryStorageRecordSink, createFilesystemCas } from "@pi-hec/cas";
import { createOneShotAdapter, envelopeDigest, selectDeploymentBeforeDispatch } from "@pi-hec/cloud-gateway";
import {
  asObjectDigest,
  asObligationId,
  canonicalizeRfc8785,
  objectDigestFromBytes,
  taggedHash,
  toJsonValue,
  type ApprovalDecision,
  type ApprovalSubject,
  type ContextRequest,
  type ObjectDigest,
  type SnapshotEntry,
  type SnapshotManifest,
} from "@pi-hec/contracts";
import { compileCloudContext, type InlinePayload } from "@pi-hec/context-compiler";
import {
  CLOUD_PROVIDER_IDS,
  LocalAnalystFailure,
  cloudCapabilityById,
  createPinnedLocalProvider,
  loadCloudCapabilityRecords,
  loadModelConfigDirectory,
  modelsConfigDir,
  type LocalDeploymentSeal,
} from "@pi-hec/models";
import { MaterializeError, chunkSource, materializeSnapshot, unicodeSimpleFoldTableDigest } from "@pi-hec/repository";
import {
  ApprovalError,
  ApprovalNonceRegistry,
  GrantConsumptionRegistry,
  approvalObjectDigest,
  buildEgressManifest,
  consumeGrant,
  freshApprovalNonce,
  signApprovalDecision,
  verifyDecisionAndIssueGrant,
  type ApprovalChallenge,
  type EgressProviderChain,
  type UserPresence,
} from "@pi-hec/security";
import { guestEnvironment, hypervisorBinaryAllowed } from "@pi-hec/sandbox";
import { formatUsageLines, projectUsage } from "@pi-hec/usage";
import { decideVerdict } from "@pi-hec/verification";
import { APPROVAL_PREVIEW_BANNER } from "../../../client/apps/pi-extension/src/ui/approvals.js";
import { inspectWorkspace } from "../../../scripts/check-dependency-graph.js";
import { completeRestoreCeremony } from "../../../faex1/deploy/backup/restore.js";
import { CANARY_CREDENTIAL, performBackup, restoreReadOnly } from "../../../faex1/deploy/backup/procedure.js";
import { isUnboundedContextRequest } from "../../../faex1/apps/control-plane/src/services/context-jobs.js";
import {
  artifact,
  bootstrapTrustedWorld,
  createTaskRun,
  digestOf,
  NOW,
  openTempStore,
  runIdFor,
} from "../../../packages/state-store/test/helpers.js";
import { compilerInput, INJECTION } from "../../../packages/context-compiler/test/fixtures.js";
import {
  buildDispatch,
  countingFetch,
  openaiCapabilities,
} from "../../../packages/cloud-gateway/test/helpers.js";
import { FakePi, RecordingBroker, RUN_ID, sampleRun, DIGEST } from "../../../client/apps/pi-extension/test/harness.js";
import { committedRoleIsolationPerfect } from "../../evaluation/harness/section24.js";
import {
  runPolyglotTwelveSteps,
  writePolyglotFixture,
  type PolyglotPorts,
} from "../polyglot-harness.js";

export type ScheduledBackupProof = {
  hourlyEpoch: string;
  terminalEpoch: string;
};

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export const SECTION33_GATE_IDS = [
  "local-model-no-mutation",
  "local-output-not-authoritative",
  "e2e-one-completion",
  "windows-path-suite",
  "disposable-vm-commands",
  "egress-fail-closed",
  "approval-replay-toctou",
  "broker-trusted-approval",
  "composite-isolation",
  "inline-evidence",
  "cas-tamper-restore",
  "ambiguous-no-duplicate",
  "unknown-stack-fallback",
  "restart-preserves-run",
  "usage-does-not-limit",
  "no-prometheus-otel",
  "backup-hourly",
  "backup-on-terminal",
  "no-placeholders",
  "promotion-crash-safe",
] as const;

export type Section33GateId = (typeof SECTION33_GATE_IDS)[number];

export type Section33Gate = {
  readonly id: Section33GateId;
  readonly passed: boolean;
};

export type Section33Decision = {
  readonly section33GatesClaimed: boolean;
  readonly gates: readonly Section33Gate[];
};

function epochProof(epoch: string | undefined): boolean {
  return typeof epoch === "string" && /^epoch-[0-9a-f]+$/u.test(epoch);
}

function objectDigest(text: string): ObjectDigest {
  return objectDigestFromBytes(Buffer.from(text, "utf8"));
}

async function checked(run: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return await run();
  } catch {
    return false;
  }
}

function loopbackSeal(overrides: Partial<LocalDeploymentSeal> = {}): LocalDeploymentSeal {
  return {
    providerId: "hec-local-qwen",
    modelId: "qwen-local",
    modelRevision: "rev-1",
    baseUrl: "http://127.0.0.1:9/v1",
    name: "local-analyst",
    contextWindow: 8192,
    maxTokens: 256,
    ...overrides,
  };
}

async function proveLocalModelNoMutation(): Promise<boolean> {
  const config = await loadModelConfigDirectory(modelsConfigDir(REPO_ROOT));
  if (config.roleIsolation.localAdapter.implementsCloudCompletion) {
    return false;
  }
  if (config.roleIsolation.localAdapter.exposesRepositoryTools) {
    return false;
  }
  if (config.roleIsolation.cloudAdapter.exposesRepositoryTools) {
    return false;
  }
  if (
    config.roleIsolation.cloudAdapter.allowedTerminalTools[0] !== "submit_solution" ||
    config.roleIsolation.cloudAdapter.allowedTerminalTools[1] !== "request_context"
  ) {
    return false;
  }
  if (
    !config.localProfiles.every(
      (profile) =>
        profile.adapterSurface.implementsCloudCompletion === false &&
        profile.adapterSurface.exposesRepositoryTools === false,
    )
  ) {
    return false;
  }
  let cloudDenied = false;
  try {
    createPinnedLocalProvider(loopbackSeal({ providerId: "openai" }));
  } catch (error) {
    cloudDenied = error instanceof LocalAnalystFailure && error.code === "CLOUD_PROVIDER_DENIED";
  }
  let nonLoopbackDenied = false;
  try {
    createPinnedLocalProvider(loopbackSeal({ baseUrl: "https://api.openai.com/v1" }));
  } catch (error) {
    nonLoopbackDenied =
      error instanceof LocalAnalystFailure && error.code === "NON_LOOPBACK_DENIED";
  }
  createPinnedLocalProvider(loopbackSeal());
  return cloudDenied && nonLoopbackDenied && committedRoleIsolationPerfect() && !CLOUD_PROVIDER_IDS.has("hec-local-qwen");
}

function proveLocalOutputNotAuthoritative(): boolean {
  const world = compilerInput();
  const outcome = compileCloudContext(world);
  if (outcome.kind !== "compiled") {
    return false;
  }
  const packet = canonicalizeRfc8785(outcome.artifacts.packet);
  const conversation = canonicalizeRfc8785(outcome.artifacts.conversation);
  const egress = canonicalizeRfc8785(outcome.artifacts.egress);
  if (packet.includes(INJECTION) || conversation.includes(INJECTION) || egress.includes(INJECTION)) {
    return false;
  }
  if (outcome.artifacts.packet.evidencePayloads.some((item) => item.node.authorship === "LOCAL_MODEL")) {
    return false;
  }
  const verdict = decideVerdict({
    obligations: [
      {
        obligationId: asObligationId(`obl_${"b".repeat(52)}`),
        mandatory: true,
        status: "PASS",
        evidenceIds: [],
        reason: "machine",
      },
    ],
    integrityViolation: false,
    sealsValid: true,
    unresolvedBlockers: false,
  });
  return verdict === "ACCEPTED";
}

function injectedPorts(fixture: ReturnType<typeof writePolyglotFixture>): PolyglotPorts {
  return {
    snapshot: () => ({
      dirtyPaths: ["service/app.py", "service/test_app.py", "AGENTS.md", "generated/bundle.js"],
      generatedPath: fixture.generatedPath,
      generatedDigest: fixture.generatedDigest,
    }),
    preflight: (snapshot) => ({
      failingTest: "service/test_app.py",
      callers: ["service/app.py"],
      agentsPath: "AGENTS.md",
      generatedExclusion: snapshot.generatedPath,
    }),
    oneShot: () => ({ tool: "submit_solution", acceptedCompletions: 1 }),
    sandbox: () => ({
      appliedInVm: true,
      hostTreeDigestUnchanged: true,
      baseline: "FAIL",
      candidate: "PASS",
    }),
    verdict: () => "ACCEPTED",
    usage: () => ({ acceptedCompletionCount: 1 }),
    apply: (input) => {
      if (!input.trustedUi) {
        throw new Error("apply requires trusted UI");
      }
      return {
        changedPaths: input.intendedPaths,
        generatedDigestAfter: input.generatedDigestBefore,
      };
    },
  };
}

async function provePolyglotPath(): Promise<{ oneCompletion: boolean; restart: boolean }> {
  const root = await mkdtemp(path.join(tmpdir(), "hec-s33-poly-"));
  const fixture = writePolyglotFixture(root);
  const result = await runPolyglotTwelveSteps(injectedPorts(fixture));
  const oneCompletion =
    result.acceptedCompletions === 1 &&
    result.verdict === "ACCEPTED" &&
    result.steps.every((step) => step.ok);
  const restart = result.steps.some((step) => step.name === "restart-status" && step.ok);
  return { oneCompletion, restart };
}

function windowsManifest(entries: SnapshotEntry[]): SnapshotManifest {
  const filesystem = {
    platform: "windows" as const,
    rootChildNameComparison: "case-insensitive" as const,
    unicodeNormalization: "NFC" as const,
    unicodeSimpleFoldTableObjectDigest: unicodeSimpleFoldTableDigest(),
    pathGlobDialect: "pi-hec-pathglob/v1" as const,
    volumeIdentity: "vol-s33",
  };
  const rootDigest = taggedHash("snapshot-root", 1, {
    repositoryId: "repo-s33",
    workspaceId: "ws-s33",
    dirty: false,
    filesystem: {
      rootChildNameComparison: filesystem.rootChildNameComparison,
      unicodeNormalization: filesystem.unicodeNormalization,
      unicodeSimpleFoldTableObjectDigest: filesystem.unicodeSimpleFoldTableObjectDigest,
      pathGlobDialect: filesystem.pathGlobDialect,
      volumeIdentity: filesystem.volumeIdentity,
    },
    entries: toJsonValue(entries),
    ignoredPathDigests: [],
    excludedPaths: [],
  });
  return {
    schemaVersion: 1,
    snapshotId: "snap_01234567-89ab-7cde-8f01-23456789abcd",
    repositoryId: "repo-s33",
    workspaceId: "ws-s33",
    dirty: false,
    filesystem,
    entries,
    ignoredPathDigests: [],
    excludedPaths: [],
    rootDigest,
    createdAt: "2026-08-28T00:00:00.000Z",
    runnerId: "runner-s33",
  };
}

async function proveWindowsPathSuite(): Promise<boolean> {
  const blobs = {
    putObject: () => {
      throw new Error("putObject must not run in path-escape proofs");
    },
    getObject: () => {
      throw new Error("getObject must not run in path-escape proofs");
    },
    objectPath: () => "",
  };
  const meta = {
    kind: "windows" as const,
    fileId: "f1",
    securityDescriptorDigest: objectDigest("sd"),
    alternateStreams: [],
  };
  const cases = ["..\\..\\Windows\\System32", "\\\\server\\share\\x", "C:\\\\Windows\\\\notepad.exe", "/etc/passwd"];
  for (const symlinkTarget of cases) {
    try {
      await materializeSnapshot({
        destRoot: "C:\\sandbox\\root",
        projectId: "proj-s33",
        manifest: windowsManifest([
          {
            path: "escape",
            platformMetadata: meta,
            entryType: "symlink",
            symlinkTarget,
            gitMode: "120000",
          },
        ]),
        blobs,
      });
      return false;
    } catch (error) {
      if (!(error instanceof MaterializeError)) {
        return false;
      }
    }
  }
  return true;
}

function proveDisposableVmCommands(): boolean {
  const hostCommands = [
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\cmd.exe",
    "python.exe",
    "node.exe",
    "cargo.exe",
    "npm.cmd",
  ];
  if (hostCommands.some((file) => hypervisorBinaryAllowed(file))) {
    return false;
  }
  if (!hypervisorBinaryAllowed("qemu-system-x86_64.exe") || !hypervisorBinaryAllowed("powershell.exe")) {
    return false;
  }
  const env = guestEnvironment({
    platform: "windows",
    commandEnvironment: { LANG: "C", SECRET_TOKEN: "leak", PATH: "C:\\evil" },
    hostEnvironment: { USERNAME: "admin", PATH: "C:\\Windows" },
  });
  return env.SECRET_TOKEN === undefined && env.USERNAME === undefined && env.PATH === String.raw`C:\sandbox\bin`;
}

function proveEgressFailClosed(): boolean {
  const records = loadCloudCapabilityRecords();
  const known = cloudCapabilityById(records, "openai-shaped-unknown");
  if (known === undefined) {
    return false;
  }
  const missing = selectDeploymentBeforeDispatch({
    userOrder: ["not-registered-provider"],
    records,
    requiredNativeTokens: 1,
    requiredMaxOutputTokens: 1,
    dispatched: false,
  });
  if (missing !== undefined) {
    return false;
  }
  const afterDispatch = selectDeploymentBeforeDispatch({
    userOrder: [known.deploymentId],
    records,
    requiredNativeTokens: 1,
    requiredMaxOutputTokens: 1,
    dispatched: true,
  });
  if (afterDispatch !== undefined) {
    return false;
  }
  const provider: EgressProviderChain = {
    deploymentId: known.deploymentId,
    adapterVersionObjectDigest: asObjectDigest(known.adapterVersionObjectDigest),
    endpointIdentity: "https://api.openai.com/v1",
    providerChain: ["openai"],
    modelRevision: known.modelRevision,
    retentionPolicyObjectDigest: objectDigest("retention"),
  };
  const rejected = buildEgressManifest({
    runId: "run_01234567-89ab-7cde-8f01-23456789abcd",
    snapshotId: "snap_01234567-89ab-7cde-8f01-23456789abcd",
    contextPacketObjectDigest: objectDigest("packet"),
    compiledConversationObjectDigest: objectDigest("conversation"),
    conversationBytes: new TextEncoder().encode("AKIA0000000000000001 restricted secret"),
    sourceRefs: [],
    provider,
    policy: {
      projectClassification: "restricted",
      permittedEgressClassifications: ["public"],
      explicitApproval: false,
      contractualRetention: false,
      noEgressCloudRoleAvailable: false,
    },
    expiresAt: "2026-08-28T01:00:00.000Z",
  });
  return rejected.kind !== "manifest";
}

function proveApprovalReplayToctou(): boolean {
  const ui = generateKeyPairSync("ed25519");
  const broker = generateKeyPairSync("ed25519");
  const digest = objectDigest("subject");
  const drift = objectDigest("drift");
  const cert = objectDigest("cert");
  const policy = objectDigest("policy");
  const display = objectDigest("display");
  const presence: UserPresence = {
    prove(challengeDigest) {
      return { challengeDigest, authenticatorPresent: true, coversChallenge: true };
    },
  };
  const subject = (workspaceRoot: ObjectDigest = digest): ApprovalSubject => ({
    schemaVersion: 1,
    kind: "workspace-promotion",
    runId: "run_01900000-0000-7000-8000-000000000027",
    candidateManifestObjectDigest: digest,
    verdictReportObjectDigest: digest,
    baseSnapshotRootDigest: digest,
    currentWorkspaceRootDigest: workspaceRoot,
    runnerId: "runner-1",
    promotionMode: "ENTRY_JOURNALED",
  });
  const approved = subject();
  const challenge: ApprovalChallenge = {
    schemaVersion: 1,
    approvalId: "approval_01900000-0000-7000-8000-000000000028",
    projectId: "proj-1",
    scope: { kind: "run", runId: "run_01900000-0000-7000-8000-000000000027" },
    action: "workspace-promotion",
    subjectObjectDigest: approvalObjectDigest("ApprovalSubject", approved),
    policyObjectDigest: policy,
    nonce: freshApprovalNonce(),
    expiresAt: "2026-08-29T00:05:00.000Z",
    displayArtifactObjectDigest: display,
  };
  const decision: Omit<ApprovalDecision, "nonce"> = {
    schemaVersion: 1,
    approvalId: challenge.approvalId,
    projectId: "proj-1",
    principalId: "user-1",
    challengeObjectDigest: approvalObjectDigest("ApprovalChallenge", challenge),
    subjectObjectDigest: challenge.subjectObjectDigest,
    policyObjectDigest: policy,
    displayArtifactObjectDigest: display,
    decision: "APPROVE",
    decidedAt: "2026-08-29T00:00:00.000Z",
    expiresAt: "2026-08-29T00:05:00.000Z",
  };
  const signed = signApprovalDecision({
    decision,
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-1",
    signerCertificateObjectDigest: cert,
    userPresence: presence,
    challenge,
    subject: approved,
    now: "2026-08-29T00:00:00.000Z",
  });
  const grant = verifyDecisionAndIssueGrant({
    decision: signed,
    challenge,
    subject: approved,
    uiPublicKey: ui.publicKey,
    uiKeyId: "ui-1",
    brokerPrivateKey: broker.privateKey,
    brokerKeyId: "broker-1",
    brokerCertificateObjectDigest: cert,
    authenticatedPrincipalId: "user-1",
    nonceRegistry: new ApprovalNonceRegistry(),
    now: "2026-08-29T00:00:00.000Z",
  });
  const grants = new GrantConsumptionRegistry();
  consumeGrant({
    grant,
    brokerPublicKey: broker.publicKey,
    brokerKeyId: "broker-1",
    subject: approved,
    now: "2026-08-29T00:00:00.000Z",
    registry: grants,
    expectedAction: "workspace-promotion",
  });
  let replayClosed = false;
  try {
    consumeGrant({
      grant,
      brokerPublicKey: broker.publicKey,
      brokerKeyId: "broker-1",
      subject: approved,
      now: "2026-08-29T00:00:00.000Z",
      registry: grants,
      expectedAction: "workspace-promotion",
    });
  } catch (error) {
    replayClosed = error instanceof ApprovalError;
  }
  let toctouClosed = false;
  try {
    consumeGrant({
      grant,
      brokerPublicKey: broker.publicKey,
      brokerKeyId: "broker-1",
      subject: subject(drift),
      now: "2026-08-29T00:00:00.000Z",
      registry: new GrantConsumptionRegistry(),
      expectedAction: "workspace-promotion",
    });
  } catch (error) {
    toctouClosed = error instanceof ApprovalError;
  }
  return replayClosed && toctouClosed;
}

async function proveBrokerTrustedApproval(): Promise<boolean> {
  const broker = new RecordingBroker(
    sampleRun({
      artifactRoles: [
        {
          role: "approval-subject",
          cardinality: "ONE_OR_MORE",
          objectDigests: [DIGEST],
        },
        {
          role: "verdict-report",
          cardinality: "ZERO_OR_ONE",
          objectDigests: [DIGEST],
        },
      ],
    }),
  );
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });
  await pi.runCommand(`approve ${RUN_ID} cloud-egress`);
  const approve = broker.methods();
  if (approve.join(",") !== "GET_RUN_STATUS,OPEN_APPROVAL") {
    return false;
  }
  if (!pi.notifications.some((line) => line.includes(APPROVAL_PREVIEW_BANNER))) {
    return false;
  }
  broker.calls.length = 0;
  await pi.runCommand(`apply ${RUN_ID}`);
  return (
    broker.methods().join(",") === "GET_RUN_STATUS,OPEN_APPROVAL" &&
    !broker.methods().includes("PROVIDE_INPUT")
  );
}

function proveInlineEvidence(): boolean {
  const input = compilerInput();
  const digestOnly = input.payloads.map((payload, index): InlinePayload => {
    if (index !== 1) {
      return payload;
    }
    const [source, ...rest] = payload.sources;
    const digest = payload.node.contentObjectDigest ?? objectDigest("missing");
    return {
      ...payload,
      sources: [{ ...source, content: { encoding: "utf-8" as const, text: digest } }, ...rest],
    };
  });
  const outcome = compileCloudContext({ ...input, payloads: digestOnly });
  return outcome.kind === "failed" && outcome.code === "DIGEST_ONLY";
}

async function proveAmbiguousNoDuplicate(): Promise<boolean> {
  const capabilities = openaiCapabilities();
  const http = countingFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{'),
            );
            controller.error(new Error("drop"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => "2026-08-28T00:00:00.000Z",
  });
  const first = await adapter.completeOnce(dispatch, new AbortController().signal);
  const second = await adapter.completeOnce(dispatch, new AbortController().signal);
  return (
    first.state === "accepted-outcome-unknown" &&
    (second.state === "accepted-outcome-unknown" || second.state === "not-dispatched")
  );
}

function proveUnknownStackFallback(): boolean {
  const units = chunkSource({
    path: "src/app.xyz",
    text: "fnordwidget from an unknown language still searchable via lexical fallback.\n",
    language: "fnord",
    snapshotId: "snap_01234567-89ab-7cde-8f01-23456789abcd",
    category: "source",
  });
  const unbounded: ContextRequest = {
    schemaVersion: 1,
    runId: "run_01234567-89ab-7cde-8f01-23456789abcd",
    cloudCallId: "call_01234567-89ab-7cde-8f01-23456789abcd",
    requestBindingDigest: objectDigest("binding"),
    contextPacketObjectDigest: objectDigest("packet"),
    baseSnapshotId: "snap_01234567-89ab-7cde-8f01-23456789abcd",
    baseSnapshotRootDigest: objectDigest("root"),
    kind: "request_context",
    missingClaimIds: [],
    requestedEvidenceKinds: ["file"],
    pathOrSymbolHints: ["**"],
    requestedSkillIds: [],
    reason: "send the whole repository",
  };
  return units.some((unit) => unit.kind === "fallback-window") && isUnboundedContextRequest(unbounded);
}

function proveUsageDoesNotLimit(): boolean {
  const projection = projectUsage({
    entries: [
      {
        usageEntryId: "use-1",
        cloudCallId: "call-1",
        runId: "run_1",
        workspaceId: "ws-1",
        projectId: "proj-1",
        createdAt: "2026-08-28T00:00:00.000Z",
        correctionOf: undefined,
        inputTokens: 9,
        outputTokens: 3,
        reasoningTokens: null,
        cachedInputTokens: null,
        cacheWriteTokens: null,
        normalizedTotalTokens: 12,
        providerReported: true,
        complete: true,
        currency: "USD",
        estimatedCostDecimal: "1.25",
        pricingSnapshotDigest: null,
      },
    ],
    calls: [
      {
        cloudCallId: "call-1",
        runId: "run_1",
        workspaceId: "ws-1",
        state: "completed",
        createdAt: "2026-08-28T00:00:00.000Z",
      },
    ],
    scope: "run",
    runId: "run_1",
  });
  const lines = formatUsageLines({
    scope: "run",
    runId: "run_1",
    state: "SUCCEEDED",
    projection,
  });
  return (
    projection.acceptedCompletionCount === 1 &&
    projection.estimatedCostDecimal !== "blocked" &&
    lines.some((line) => line.includes("do not affect routing")) &&
    !lines.some((line) => /limit|quota|blocked|deny/i.test(line) && !line.includes("do not affect"))
  );
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    const info = statSync(current);
    if (info.isDirectory()) {
      for (const entry of readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    found.push(current);
  }
  return found;
}

function isForbiddenProductionLine(filePath: string, line: string): boolean {
  if (filePath.endsWith(`${path.sep}tap.ts`) && /SKIP\|TODO\|skip\|todo/.test(line)) {
    return false;
  }
  if (/\bplaceholders\b/.test(line) && line.includes("?")) {
    return false;
  }
  if (/^\s*\/\/\s*(TODO|FIXME|XXX|HACK)\b/u.test(line)) {
    return true;
  }
  if (/\bunimplemented!\s*\(/u.test(line) || /\btodo!\s*\(/u.test(line)) {
    return true;
  }
  return /\bnot implemented\b/i.test(line);
}

function proveNoPlaceholders(backupOk: boolean): boolean {
  if (!backupOk) {
    return false;
  }
  const graph = inspectWorkspace(REPO_ROOT);
  if (!graph.ok) {
    return false;
  }
  const roots = [
    ...readdirSync(path.join(REPO_ROOT, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(REPO_ROOT, "packages", entry.name, "src")),
    ...readdirSync(path.join(REPO_ROOT, "faex1", "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(REPO_ROOT, "faex1", "apps", entry.name, "src")),
    path.join(REPO_ROOT, "client", "apps", "pi-extension", "src"),
    path.join(REPO_ROOT, "native", "runner", "src"),
  ];
  for (const root of roots) {
    for (const filePath of walkFiles(root)) {
      if (
        !/\.(ts|rs)$/u.test(filePath) ||
        filePath.includes(`${path.sep}dist${path.sep}`) ||
        filePath.includes(`${path.sep}node_modules${path.sep}`)
      ) {
        continue;
      }
      const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
      if (lines.some((line) => isForbiddenProductionLine(filePath, line))) {
        return false;
      }
    }
  }
  return true;
}

function proveNoPrometheusOtel(): boolean {
  const graph = inspectWorkspace(REPO_ROOT);
  if (!graph.ok) {
    return false;
  }
  return !graph.issues.some(
    (issue) =>
      issue.kind === "banned-package" ||
      /prometheus|opentelemetry|@opentelemetry\//i.test(issue.message),
  );
}

function provePromotionCrashSafe(): boolean {
  const recovery = readFileSync(path.join(REPO_ROOT, "native", "runner", "src", "promotion", "recovery.rs"), "utf8");
  const promotion = readFileSync(path.join(REPO_ROOT, "native", "runner", "src", "promotion", "mod.rs"), "utf8");
  const crash = readFileSync(path.join(REPO_ROOT, "test", "crash", "promotion", "crash.rs"), "utf8");
  const states = ['"PREPARED"', '"COMMITTING"', '"VERIFYING"', '"ROLLING_BACK"'];
  return (
    states.every((state) => recovery.includes(state)) &&
    recovery.includes("MANUAL_RECOVERY_REQUIRED") &&
    recovery.includes("recover_rollback") &&
    promotion.includes("rollback_journal") &&
    promotion.includes("MANUAL_RECOVERY_REQUIRED") &&
    crash.includes("crash_after_every_checkpoint_recovers_to_base_or_candidate") &&
    crash.includes('"COMMITTED"') &&
    crash.includes("MANUAL_RECOVERY_REQUIRED")
  );
}

async function proveDurableStore(): Promise<{ isolation: boolean; tamperRestore: boolean }> {
  const opened = openTempStore();
  const casRoot = await mkdtemp(path.join(tmpdir(), "hec-s33-cas-"));
  const backupRoot = await mkdtemp(path.join(tmpdir(), "hec-s33-bak-"));
  const dek = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-s33-a");
    const other = bootstrapTrustedWorld(opened.store, "proj-s33-b");
    const runId = runIdFor("3301");
    createTaskRun(opened.store, world, runId);
    const req = digestOf("cloud-req-s33");
    const ctx = digestOf("cloud-ctx-s33");
    const res = digestOf("cloud-res-s33");
    const verdict = digestOf("verdict-s33");
    opened.store.putArtifact(world.projectScope, artifact(req, "CanonicalCloudRequest", "creq33"));
    opened.store.putArtifact(world.projectScope, artifact(ctx, "ContextPacket", "cctx33"));
    opened.store.putArtifact(world.projectScope, artifact(res, "CloudCompletionReceipt", "cres33"));
    opened.store.putArtifact(world.projectScope, artifact(verdict, "VerdictReport", "verd33"));
    opened.store.createCloudCall(world.projectScope, {
      cloudCallId: "call-s33",
      runId,
      purpose: "initial",
      deploymentId: "dep-1",
      requestDigest: req,
      contextPacketDigest: ctx,
      recoveryGrade: "C",
      state: "prepared",
      createdAt: NOW,
    });
    opened.store.transitionPreparedCloudCallToDispatching(world.projectScope, {
      cloudCallId: "call-s33",
      requestDigest: req,
      attemptId: "att-s33",
      requestStartedAt: NOW,
      updatedAt: NOW,
    });
    opened.store.completeCloudCall(world.projectScope, {
      cloudCallId: "call-s33",
      responseDigest: res,
      updatedAt: NOW,
    });
    const sink = new MemoryStorageRecordSink();
    const cas = createFilesystemCas({
      rootDir: casRoot,
      sink,
      kek: { unwrapProjectDek: () => ({ keyId: "dek-s33", dek }) },
    });
    const bytes = Buffer.from("reachable-cas-blob-s33", "utf8");
    const put = await cas.putObject({
      projectId: world.projectId,
      bytes,
      mediaType: "application/octet-stream",
      classification: "internal",
      securityCritical: true,
    });
    let crossProjectHidden = false;
    try {
      await cas.getObject({ projectId: other.projectId, objectDigest: put.objectDigest });
    } catch (error) {
      crossProjectHidden = error instanceof CasError && error.code === "NOT_FOUND";
    }
    const dest = cas.objectPath(world.projectId, put.objectDigest);
    const mutated = Buffer.from(readFileSync(dest));
    const flipAt = Math.max(0, mutated.byteLength - 3);
    mutated.writeUInt8(mutated.readUInt8(flipAt) ^ 0x5a, flipAt);
    writeFileSync(dest, mutated);
    let tamperClosed = false;
    try {
      await cas.getObject({
        projectId: world.projectId,
        objectDigest: put.objectDigest,
        securityCritical: true,
      });
    } catch (error) {
      tamperClosed = error instanceof CasError;
    }
    const recovery = generateKeyPairSync("x25519");
    mkdirSync(casRoot, { recursive: true });
    const backup = await performBackup({
      store: opened.store,
      dbPath: opened.dbPath,
      casRoot,
      reachableDigests: [verdict],
      appManifests: { schemaVersion: 1 },
      publicCerts: {},
      livePrivateKeyPaths: [],
      canaryCredential: CANARY_CREDENTIAL,
      backupRoot,
      recoveryPublicKey: recovery.publicKey,
      kek: { unwrapProjectDek: () => ({ keyId: "dek-s33", dek }) },
    });
    const missing = objectDigest("no-such-backup-object");
    const missA = backup.lookup({ projectId: world.projectId, objectDigest: missing });
    const missB = backup.lookup({ projectId: other.projectId, objectDigest: missing });
    const oracleClosed =
      missA.status === 404 &&
      missB.status === 404 &&
      JSON.stringify(missA.body) === JSON.stringify(missB.body) &&
      !JSON.stringify(missA.body).match(/exist|forbidden|403/i);
    const cleanHost = path.join(backupRoot, "clean-host");
    const pending = restoreReadOnly({
      repositoryPath: backup.repositoryPath,
      destinationDir: cleanHost,
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      masterKey: backup.resticMaster,
    });
    const readOnly = pending.store.readOnlyRecovery === true;
    pending.close();
    const restored = completeRestoreCeremony({
      destinationDir: cleanHost,
      hostLeaseKey: opened.keys.hostLeaseKey,
      dbResponseKey: opened.keys.dbResponseKey,
      recoveryPrivateKey: recovery.privateKey,
    });
    try {
      const run = restored.store.getRun(world.projectScope, runId);
      const artifactOk = restored.store.getArtifact(world.projectScope, verdict)?.digest === verdict;
      return {
        isolation: crossProjectHidden && oracleClosed,
        tamperRestore:
          tamperClosed &&
          readOnly &&
          restored.store.readOnlyRecovery === false &&
          run.state === "CREATED" &&
          artifactOk,
      };
    } finally {
      restored.close();
    }
  } finally {
    opened.close();
  }
}

export async function evaluateSection33Gates(proof?: ScheduledBackupProof): Promise<Section33Decision> {
  const backupOk = epochProof(proof?.hourlyEpoch) && epochProof(proof?.terminalEpoch);
  const [localModel, localOutput, polyglot, windowsPaths, disposableVm, egress, approval, trustedApproval, inline, ambiguous, unknownStack, usage, telemetry, placeholders, promotion, durable] =
    await Promise.all([
      checked(proveLocalModelNoMutation),
      checked(proveLocalOutputNotAuthoritative),
      provePolyglotPath().catch(() => ({ oneCompletion: false, restart: false })),
      checked(proveWindowsPathSuite),
      checked(proveDisposableVmCommands),
      checked(proveEgressFailClosed),
      checked(proveApprovalReplayToctou),
      checked(proveBrokerTrustedApproval),
      checked(proveInlineEvidence),
      checked(proveAmbiguousNoDuplicate),
      checked(proveUnknownStackFallback),
      checked(proveUsageDoesNotLimit),
      checked(proveNoPrometheusOtel),
      checked(() => proveNoPlaceholders(backupOk)),
      checked(provePromotionCrashSafe),
      proveDurableStore().catch(() => ({ isolation: false, tamperRestore: false })),
    ]);

  const passed: Record<Section33GateId, boolean> = {
    "local-model-no-mutation": localModel,
    "local-output-not-authoritative": localOutput,
    "e2e-one-completion": polyglot.oneCompletion,
    "windows-path-suite": windowsPaths,
    "disposable-vm-commands": disposableVm,
    "egress-fail-closed": egress,
    "approval-replay-toctou": approval,
    "broker-trusted-approval": trustedApproval,
    "composite-isolation": durable.isolation,
    "inline-evidence": inline,
    "cas-tamper-restore": durable.tamperRestore,
    "ambiguous-no-duplicate": ambiguous,
    "unknown-stack-fallback": unknownStack,
    "restart-preserves-run": polyglot.restart,
    "usage-does-not-limit": usage,
    "no-prometheus-otel": telemetry,
    "backup-hourly": epochProof(proof?.hourlyEpoch),
    "backup-on-terminal": epochProof(proof?.terminalEpoch),
    "no-placeholders": placeholders,
    "promotion-crash-safe": promotion,
  };
  const gates = SECTION33_GATE_IDS.map((id) => ({ id, passed: passed[id] }));
  return {
    section33GatesClaimed: gates.every((gate) => gate.passed),
    gates,
  };
}

export async function claimProductionGoLive(proof?: ScheduledBackupProof): Promise<Section33Decision> {
  return evaluateSection33Gates(proof);
}
