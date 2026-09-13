import { test } from "vitest";
import {
  SourceRangeSchema,
  SourceRefSchema,
  SnapshotEntrySchema,
  ApplyReceiptSchema,
} from "../src/schemas/artifacts.js";
import { RequirementSchema, RunDomainEventSchema } from "../src/schemas/run.js";
import {
  CanonicalCloudRequestSchema,
  ChangeOperationSchema,
  CloudCompletionReceiptSchema,
  CloudResultSchema,
} from "../src/schemas/cloud.js";
import { SandboxJobResultSchema } from "../src/schemas/sandbox.js";
import { ApprovalSubjectSchema } from "../src/schemas/secrets.js";
import { BrokerRequestSchema } from "../src/schemas/broker.js";
import { ENTER_TARGET_STATES } from "../src/generated/run-states.js";
import {
  BASE64,
  CALL,
  DIGEST,
  EVIDENCE,
  OP,
  posixMeta,
  PROJ,
  REQ,
  RUN,
  SNAP,
  TS,
  acceptAndRejectExtra,
  cloudResultBinding,
  initialRequestBinding,
} from "./helpers.js";

const quoteRange = { kind: "whole" as const };

test("SourceRange variants accept and reject extra properties", () => {
  acceptAndRejectExtra(SourceRangeSchema, { kind: "whole" });
  acceptAndRejectExtra(SourceRangeSchema, { kind: "bytes", byteStart: 0, byteEnd: 8 });
});

test("SourceRef origin variants accept and reject extra properties", () => {
  acceptAndRejectExtra(SourceRefSchema, {
    origin: "repository",
    sourceKind: "repository",
    snapshotId: SNAP,
    artifactObjectDigest: DIGEST,
    path: "src/app.ts",
    range: quoteRange,
    quoteDigest: DIGEST,
  });
  acceptAndRejectExtra(SourceRefSchema, {
    origin: "artifact",
    sourceKind: "user-task",
    artifactObjectDigest: DIGEST,
    range: quoteRange,
    quoteDigest: DIGEST,
  });
  acceptAndRejectExtra(SourceRefSchema, {
    origin: "external",
    sourceKind: "external-documentation",
    fetchReceiptObjectDigest: DIGEST,
    artifactObjectDigest: DIGEST,
    url: "https://example.test/docs",
    range: quoteRange,
    quoteDigest: DIGEST,
  });
});

test("Requirement kinds accept and reject extra properties", () => {
  acceptAndRejectExtra(RequirementSchema, {
    id: REQ,
    text: "must compile",
    sourceRefs: [],
    priority: "MUST",
    state: "CLEAR",
    kind: "authoritative",
    source: "USER_EXPLICIT",
    normative: true,
  });
  acceptAndRejectExtra(RequirementSchema, {
    id: REQ,
    text: "has a test",
    sourceRefs: [],
    priority: "SHOULD",
    state: "CLEAR",
    kind: "deterministic-check",
    source: "EXISTING_TEST",
    normative: false,
  });
});

test("ChangeOperation all nine kinds accept and reject extra properties", () => {
  acceptAndRejectExtra(ChangeOperationSchema, {
    kind: "text_patch",
    path: "src/a.ts",
    expectedBeforeDigest: DIGEST,
    expectedAfterDigest: DIGEST,
    unifiedDiff: "@@ -1 +1 @@\n-a\n+b\n",
    insertedLineEnding: "LF",
    finalNewline: "PRESENT",
  });
  acceptAndRejectExtra(ChangeOperationSchema, {
    kind: "create_text",
    path: "src/new.ts",
    content: "export {}\n",
    expectedAfterDigest: DIGEST,
    gitMode: "100644",
    expectedAbsent: true,
  });
  acceptAndRejectExtra(ChangeOperationSchema, {
    kind: "create_directory",
    path: "src/new",
    expectedAbsent: true,
  });
  acceptAndRejectExtra(ChangeOperationSchema, {
    kind: "write_binary",
    path: "src/a.bin",
    expectedBeforeDigest: null,
    mediaType: "application/octet-stream",
    base64Content: BASE64,
    expectedAfterDigest: DIGEST,
    gitMode: "100644",
  });
  acceptAndRejectExtra(ChangeOperationSchema, {
    kind: "delete",
    path: "src/old.ts",
    expectedBeforeDigest: DIGEST,
  });
  acceptAndRejectExtra(ChangeOperationSchema, {
    kind: "delete_directory",
    path: "src/gone",
    expectedTreeDigest: DIGEST,
    expectedEmptyAtOperation: true,
  });
  acceptAndRejectExtra(ChangeOperationSchema, {
    kind: "move",
    from: "src/a.ts",
    to: "src/b.ts",
    expectedBeforeDigest: DIGEST,
    expectedDestinationDigest: null,
  });
  acceptAndRejectExtra(ChangeOperationSchema, {
    kind: "set_git_mode",
    path: "src/tool.sh",
    expectedBeforeDigest: DIGEST,
    expectedCurrentMode: "100644",
    newMode: "100755",
  });
  acceptAndRejectExtra(ChangeOperationSchema, {
    kind: "symlink",
    path: "src/link",
    target: "src/target",
    expectedBeforeDigest: null,
    expectedAfterDigest: DIGEST,
  });
});

test("CloudResult request_context and SubmittedSolution dispositions", () => {
  acceptAndRejectExtra(CloudResultSchema, {
    ...cloudResultBinding,
    kind: "request_context",
    missingClaimIds: [EVIDENCE],
    requestedEvidenceKinds: [],
    pathOrSymbolHints: [],
    requestedSkillIds: [],
    reason: "need more graph",
  });
  acceptAndRejectExtra(CloudResultSchema, {
    ...cloudResultBinding,
    kind: "submit_solution",
    summary: "patch",
    assumptions: [],
    unresolvedFacts: [],
    disposition: "solution",
    changeSet: {
      schemaVersion: 1,
      baseSnapshotId: SNAP,
      baseSnapshotRootDigest: DIGEST,
      operations: [{ kind: "delete", path: "src/old.ts", expectedBeforeDigest: DIGEST }],
    },
    requirementTrace: [
      {
        requirementId: REQ,
        satisfaction: "changed",
        operationIndexes: [0],
        testPaths: ["test/a.test.ts"],
        evidenceIds: [EVIDENCE],
      },
    ],
    verificationProposals: [],
  });
  acceptAndRejectExtra(CloudResultSchema, {
    ...cloudResultBinding,
    kind: "submit_solution",
    summary: "already done",
    assumptions: [],
    unresolvedFacts: [],
    disposition: "no_change",
    noChangeEvidenceIds: [EVIDENCE],
    requirementTrace: [{ requirementId: REQ, evidenceIds: [EVIDENCE] }],
  });
  acceptAndRejectExtra(CloudResultSchema, {
    ...cloudResultBinding,
    kind: "submit_solution",
    summary: "need input",
    assumptions: [],
    unresolvedFacts: [],
    disposition: "needs_user_input",
    questions: [
      {
        clientQuestionKey: "q1",
        prompt: "which API?",
        correctnessImpact: "blocking",
        relatedRequirementIds: [REQ],
      },
    ],
    blockedRequirementIds: [REQ],
  });
});

test("SnapshotEntry variants accept and reject extra properties", () => {
  acceptAndRejectExtra(SnapshotEntrySchema, {
    path: "src/app.ts",
    platformMetadata: posixMeta,
    entryType: "file",
    contentDigest: DIGEST,
    size: 12,
    gitMode: "100644",
    storage: { kind: "blob", objectDigest: DIGEST },
  });
  acceptAndRejectExtra(SnapshotEntrySchema, {
    path: "src/big.bin",
    platformMetadata: posixMeta,
    entryType: "file",
    contentDigest: DIGEST,
    size: 8,
    gitMode: "100755",
    storage: {
      kind: "chunks",
      chunks: [{ digest: DIGEST, offset: 0, length: 8 }],
    },
  });
  acceptAndRejectExtra(SnapshotEntrySchema, {
    path: "src",
    platformMetadata: posixMeta,
    entryType: "directory",
    childNameComparison: "case-sensitive",
  });
  acceptAndRejectExtra(SnapshotEntrySchema, {
    path: "src/link",
    platformMetadata: posixMeta,
    entryType: "symlink",
    symlinkTarget: "src/app.ts",
    gitMode: "120000",
  });
  acceptAndRejectExtra(SnapshotEntrySchema, {
    path: "vendor/lib",
    platformMetadata: posixMeta,
    entryType: "submodule",
    gitObjectId: "abc123",
    gitMode: "160000",
  });
});

const applyBase = {
  schemaVersion: 1 as const,
  runId: RUN,
  approvalId: "approval_01234567-89ab-7cde-8f01-23456789abcd",
  workspaceId: PROJ,
  candidateManifestObjectDigest: DIGEST,
  baseSnapshotRootDigest: DIGEST,
  changeSetObjectDigest: DIGEST,
  journalObjectDigest: DIGEST,
  promotionMode: "ENTRY_JOURNALED" as const,
  affectedPaths: [],
  completedAt: TS,
};

test("ApplyReceipt outcomes accept and reject extra properties", () => {
  acceptAndRejectExtra(ApplyReceiptSchema, {
    ...applyBase,
    outcome: "COMMITTED",
    resultingRootDigest: DIGEST,
    visibilityGuarantee: "ENTRY_LEVEL",
  });
  acceptAndRejectExtra(ApplyReceiptSchema, {
    ...applyBase,
    outcome: "ROLLED_BACK",
    restoredRootDigest: DIGEST,
  });
  acceptAndRejectExtra(ApplyReceiptSchema, {
    ...applyBase,
    outcome: "STALE",
    observedWorkspaceRootDigest: DIGEST,
  });
  acceptAndRejectExtra(ApplyReceiptSchema, {
    ...applyBase,
    outcome: "MANUAL_RECOVERY_REQUIRED",
    observedWorkspaceRootDigest: DIGEST,
    recoveryEvidenceObjectDigest: DIGEST,
  });
});

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: null,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  totalTokens: 2,
  providerReported: true,
  complete: true,
  estimatedCost: null,
};

const receiptBase = {
  schemaVersion: 1 as const,
  runId: RUN,
  cloudCallId: CALL,
  requestEnvelopeObjectDigest: DIGEST,
  providerWireRequestObjectDigest: DIGEST,
  providerWireRequestDigest: DIGEST,
  deploymentId: PROJ,
  completedAt: TS,
  usage,
};

test("CloudCompletionReceipt outcomes accept and reject extra properties", () => {
  acceptAndRejectExtra(CloudCompletionReceiptSchema, {
    ...receiptBase,
    outcome: "VALID_RESULT",
    acceptedAt: TS,
    finishReason: "stop",
    rawResponseArtifactObjectDigest: DIGEST,
    result: {
      ...cloudResultBinding,
      kind: "request_context",
      missingClaimIds: [EVIDENCE],
      requestedEvidenceKinds: [],
      pathOrSymbolHints: [],
      requestedSkillIds: [],
      reason: "need more graph",
    },
    resultObjectDigest: DIGEST,
  });
  acceptAndRejectExtra(CloudCompletionReceiptSchema, {
    ...receiptBase,
    outcome: "INCOMPLETE",
    acceptedAt: TS,
    finishReason: "length",
    incidentRecordObjectDigest: DIGEST,
    error: { code: "length", retryClass: "DO_NOT_RETRY", message: "truncated" },
  });
  acceptAndRejectExtra(CloudCompletionReceiptSchema, {
    ...receiptBase,
    outcome: "FAILED",
    acceptedness: "PROVEN_NOT_ACCEPTED",
    finishReason: "error",
    transportEvidenceObjectDigest: DIGEST,
    error: { code: "transport", retryClass: "SAFE_SAME_REQUEST", message: "reset" },
  });
  acceptAndRejectExtra(CloudCompletionReceiptSchema, {
    ...receiptBase,
    outcome: "FAILED",
    acceptedness: "ACCEPTED",
    acceptedAt: TS,
    finishReason: "error",
    incidentRecordObjectDigest: DIGEST,
    error: { code: "provider", retryClass: "RECONCILE_FIRST", message: "500" },
  });
});

test("SandboxJobResult outcomes accept and reject extra properties", () => {
  acceptAndRejectExtra(SandboxJobResultSchema, {
    schemaVersion: 1,
    outcome: "COMPLETED",
    projectId: PROJ,
    runId: RUN,
    operationId: OP,
    leaseGeneration: 1,
    sandboxJobObjectDigest: DIGEST,
    exitCode: 0,
    termination: "EXITED",
    stdoutObjectDigest: DIGEST,
    stderrObjectDigest: DIGEST,
    producedArtifactObjectDigests: [],
    observedOutputTreeDigest: DIGEST,
    resourceUsage: {
      cpuMillis: 1,
      peakMemoryBytes: 1,
      peakProcessCount: 1,
      writtenBytes: 0,
      networkSentBytes: 0,
      networkReceivedBytes: 0,
      wallClockMillis: 1,
    },
    startedAt: TS,
    completedAt: TS,
  });
  acceptAndRejectExtra(SandboxJobResultSchema, {
    schemaVersion: 1,
    outcome: "REJECTED",
    projectId: PROJ,
    runId: RUN,
    operationId: OP,
    leaseGeneration: 1,
    sandboxJobObjectDigest: DIGEST,
    reasonCode: "policy",
    evidenceObjectDigest: DIGEST,
    completedAt: TS,
  });
  acceptAndRejectExtra(SandboxJobResultSchema, {
    schemaVersion: 1,
    outcome: "OUTCOME_UNKNOWN",
    projectId: PROJ,
    runId: RUN,
    operationId: OP,
    leaseGeneration: 1,
    sandboxJobObjectDigest: DIGEST,
    lastEvidenceObjectDigest: DIGEST,
    completedAt: TS,
  });
});

test("ApprovalSubject kinds accept and reject extra properties", () => {
  acceptAndRejectExtra(ApprovalSubjectSchema, {
    schemaVersion: 1,
    kind: "cloud-egress",
    runId: RUN,
    cloudCallId: CALL,
    baseSnapshotRootDigest: DIGEST,
    contextPacketObjectDigest: DIGEST,
    compiledConversationObjectDigest: DIGEST,
    egressManifestObjectDigest: DIGEST,
    canonicalCloudRequestObjectDigest: DIGEST,
    providerWireRequestObjectDigest: DIGEST,
    deploymentId: PROJ,
    adapterVersionObjectDigest: DIGEST,
    endpointIdentity: "https://provider.test",
    modelRevision: "m1",
    retentionPolicyObjectDigest: DIGEST,
  });
  acceptAndRejectExtra(ApprovalSubjectSchema, {
    schemaVersion: 1,
    kind: "command",
    runId: RUN,
    phase: "BASELINE",
    resolvedCommandSpecObjectDigest: DIGEST,
    environmentSealObjectDigest: DIGEST,
    sandboxPolicyObjectDigest: DIGEST,
    inputTreeRootDigest: DIGEST,
  });
  acceptAndRejectExtra(ApprovalSubjectSchema, {
    schemaVersion: 1,
    kind: "workspace-promotion",
    runId: RUN,
    candidateManifestObjectDigest: DIGEST,
    verdictReportObjectDigest: DIGEST,
    baseSnapshotRootDigest: DIGEST,
    currentWorkspaceRootDigest: DIGEST,
    runnerId: PROJ,
    promotionMode: "ENTRY_JOURNALED",
  });
  acceptAndRejectExtra(ApprovalSubjectSchema, {
    schemaVersion: 1,
    kind: "project-trust",
    projectId: PROJ,
    proposedPolicyObjectDigest: DIGEST,
    classification: "internal",
    enrollingPrincipalId: "user-1",
    requestedTrust: "trusted",
  });
  acceptAndRejectExtra(ApprovalSubjectSchema, {
    schemaVersion: 1,
    kind: "workspace-registration",
    projectId: PROJ,
    workspaceId: "ws1",
    runnerId: PROJ,
    rootFingerprint: "fp",
    platform: "linux",
    brokerAttestationObjectDigest: DIGEST,
  });
  acceptAndRejectExtra(ApprovalSubjectSchema, {
    schemaVersion: 1,
    kind: "project-policy",
    projectId: PROJ,
    priorPolicyObjectDigest: DIGEST,
    proposedPolicyObjectDigest: DIGEST,
  });
});

test("BrokerRequest methods accept and reject extra properties", () => {
  acceptAndRejectExtra(BrokerRequestSchema, {
    requestId: "r1",
    method: "START_RUN",
    params: {
      workspaceAlias: "main",
      originalRequest: "build",
      attachmentHandles: [],
    },
  });
  acceptAndRejectExtra(BrokerRequestSchema, {
    requestId: "r1",
    method: "GET_RUN_STATUS",
    params: { runId: RUN },
  });
  acceptAndRejectExtra(BrokerRequestSchema, {
    requestId: "r1",
    method: "POLL_RUN_EVENTS",
    params: { runId: RUN, afterSequence: 0, limit: 20 },
  });
  acceptAndRejectExtra(BrokerRequestSchema, {
    requestId: "r1",
    method: "OPEN_TRUSTED_VIEW",
    params: { runId: RUN, view: "DIFF" },
  });
  acceptAndRejectExtra(BrokerRequestSchema, {
    requestId: "r1",
    method: "OPEN_APPROVAL",
    params: { action: "project-trust", subjectObjectDigest: DIGEST },
  });
  acceptAndRejectExtra(BrokerRequestSchema, {
    requestId: "r1",
    method: "PROVIDE_INPUT",
    params: { runId: RUN, expectedStateVersion: 1, questionId: "q1", answer: "yes" },
  });
  acceptAndRejectExtra(BrokerRequestSchema, {
    requestId: "r1",
    method: "REQUEST_REPAIR",
    params: { runId: RUN, expectedStateVersion: 1, verdictReportObjectDigest: DIGEST },
  });
  acceptAndRejectExtra(BrokerRequestSchema, {
    requestId: "r1",
    method: "CANCEL_RUN",
    params: { runId: RUN, expectedStateVersion: 1, reason: "stop" },
  });
  acceptAndRejectExtra(BrokerRequestSchema, {
    requestId: "r1",
    method: "RESUME_RUN",
    params: { runId: RUN },
  });
  acceptAndRejectExtra(BrokerRequestSchema, {
    requestId: "r1",
    method: "LIST_AGENTS",
    params: { runId: RUN },
  });
});

test("CanonicalCloudRequest purposes accept and reject extra properties", () => {
  const base = {
    schemaVersion: 1 as const,
    runId: RUN,
    cloudCallId: CALL,
    requestBindingDigest: DIGEST,
    deploymentId: PROJ,
    adapterVersionObjectDigest: DIGEST,
    contextPacketObjectDigest: DIGEST,
    egressManifestObjectDigest: DIGEST,
    compiledConversationObjectDigest: DIGEST,
    resultMode: "terminal-tools" as const,
    maxOutputTokens: 1024,
    reasoningProfile: "default",
  };
  acceptAndRejectExtra(CanonicalCloudRequestSchema, {
    ...base,
    purpose: "initial",
    requestBinding: initialRequestBinding,
  });
  const followupBinding = {
    ...initialRequestBinding,
    purpose: "context-followup" as const,
    parentCloudCallId: CALL,
    contextDeltaObjectDigest: DIGEST,
  };
  acceptAndRejectExtra(CanonicalCloudRequestSchema, {
    ...base,
    purpose: "context-followup",
    parentCloudCallId: CALL,
    contextDeltaObjectDigest: DIGEST,
    requestBinding: followupBinding,
  });
  const repairBinding = {
    ...initialRequestBinding,
    purpose: "repair" as const,
    parentCloudCallId: CALL,
    repairPacketObjectDigest: DIGEST,
    priorCandidateManifestObjectDigest: DIGEST,
  };
  acceptAndRejectExtra(CanonicalCloudRequestSchema, {
    ...base,
    purpose: "repair",
    parentCloudCallId: CALL,
    repairPacketObjectDigest: DIGEST,
    priorCandidateManifestObjectDigest: DIGEST,
    requestBinding: repairBinding,
  });
});

test("RunDomainEvent ENTER_* and global events accept and reject extra properties", () => {
  for (const target of ENTER_TARGET_STATES) {
    acceptAndRejectExtra(RunDomainEventSchema, {
      schemaVersion: 1,
      eventId: "evt-1",
      projectId: PROJ,
      runId: RUN,
      expectedStateVersion: 0,
      actorType: "control",
      actorId: "control-1",
      occurredAt: TS,
      eventType: `ENTER_${target}`,
      payload: {
        target,
        reasonCode: "advance",
        inputArtifactObjectDigests: [],
        outputArtifactObjectDigests: [],
      },
    });
  }
  acceptAndRejectExtra(RunDomainEventSchema, {
    schemaVersion: 1,
    eventId: "evt-1",
    projectId: PROJ,
    runId: RUN,
    expectedStateVersion: 0,
    actorType: "user",
    actorId: "user-1",
    occurredAt: TS,
    eventType: "USER_CANCELLATION_REQUESTED",
    payload: { reason: "stop" },
  });
  acceptAndRejectExtra(RunDomainEventSchema, {
    schemaVersion: 1,
    eventId: "evt-1",
    projectId: PROJ,
    runId: RUN,
    expectedStateVersion: 0,
    actorType: "control",
    actorId: "control-1",
    occurredAt: TS,
    eventType: "CANCELLATION_SETTLED",
    payload: {
      cancellationReceiptObjectDigest: DIGEST,
      providerOutcome: "NOT_DISPATCHED",
    },
  });
  acceptAndRejectExtra(RunDomainEventSchema, {
    schemaVersion: 1,
    eventId: "evt-1",
    projectId: PROJ,
    runId: RUN,
    expectedStateVersion: 0,
    actorType: "broker",
    actorId: "broker-1",
    occurredAt: TS,
    eventType: "CANCELLATION_OUTCOME_UNKNOWN",
    payload: {
      cancellationReceiptObjectDigest: DIGEST,
      providerOutcome: "UNKNOWN",
    },
  });
  acceptAndRejectExtra(RunDomainEventSchema, {
    schemaVersion: 1,
    eventId: "evt-1",
    projectId: PROJ,
    runId: RUN,
    expectedStateVersion: 0,
    actorType: "control",
    actorId: "control-1",
    occurredAt: TS,
    eventType: "UNRECOVERABLE_PLATFORM_FAILURE",
    payload: {
      failureArtifactObjectDigest: DIGEST,
      recoveryAttemptObjectDigests: [],
    },
  });
});
