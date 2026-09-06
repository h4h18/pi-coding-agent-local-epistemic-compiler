import { expect, test } from "vitest";
import { Compile } from "typebox/compile";
import {
  SourceRangeSchema,
  SourceRefSchema,
  SuccessfulRunResultSchema,
} from "../src/schemas/artifacts.js";
import { RequirementSchema } from "../src/schemas/run.js";
import { ChangeOperationSchema, CloudResultSchema } from "../src/schemas/cloud.js";
import { SandboxJobResultSchema } from "../src/schemas/sandbox.js";
import { ApprovalGrantSchema, ApprovalSubjectSchema } from "../src/schemas/secrets.js";
import { BrokerRequestSchema } from "../src/schemas/broker.js";
import { OperationResultRequestSchema } from "../src/schemas/http.js";
import { acceptAndRejectExtra as rejectExtra } from "./helpers.js";

const digest = "sha256:" + "ab".repeat(32);
const snap = "snap_01234567-89ab-7cde-8f01-23456789abcd";
const run = "run_01234567-89ab-7cde-8f01-23456789abcd";
const req = "req_" + "a".repeat(52);
const evidence = "evidence_" + "a".repeat(52);
const quote = digest;

test("SourceRange variants accept and reject unknown kind extra and missing", () => {
  const validator = Compile(SourceRangeSchema);
  expect(validator.Check({ kind: "whole" })).toBe(true);
  expect(validator.Check({ kind: "bytes", byteStart: 0, byteEnd: 4 })).toBe(true);
  expect(validator.Check({ kind: "lines" })).toBe(false);
  expect(validator.Check({ kind: "bytes", byteStart: 0 })).toBe(false);
  expect(validator.Check({ kind: "whole", extra: 1 })).toBe(false);
});

test("SourceRef origin variants", () => {
  const validator = Compile(SourceRefSchema);
  expect(
    validator.Check({
      origin: "repository",
      sourceKind: "repository",
      snapshotId: snap,
      artifactObjectDigest: digest,
      path: "src/app.js",
      range: { kind: "whole" },
      quoteDigest: quote,
    }),
  ).toBe(true);
  expect(
    validator.Check({
      origin: "artifact",
      sourceKind: "user-task",
      artifactObjectDigest: digest,
      range: { kind: "whole" },
      quoteDigest: quote,
    }),
  ).toBe(true);
  expect(
    validator.Check({
      origin: "external",
      sourceKind: "external-documentation",
      fetchReceiptObjectDigest: digest,
      artifactObjectDigest: digest,
      url: "https://example.test/docs",
      range: { kind: "whole" },
      quoteDigest: quote,
    }),
  ).toBe(true);
  expect(validator.Check({ origin: "memory", sourceKind: "repository" })).toBe(false);
});

test("Requirement discriminated kind", () => {
  const validator = Compile(RequirementSchema);
  const base = {
    id: req,
    text: "must compile",
    sourceRefs: [],
    priority: "MUST",
    state: "CLEAR",
  };
  expect(
    validator.Check({ ...base, kind: "authoritative", source: "USER_EXPLICIT", normative: true }),
  ).toBe(true);
  expect(
    validator.Check({
      ...base,
      kind: "deterministic-check",
      source: "EXISTING_TEST",
      normative: false,
    }),
  ).toBe(true);
  expect(
    validator.Check({ ...base, kind: "authoritative", source: "USER_EXPLICIT", normative: false }),
  ).toBe(false);
  expect(
    validator.Check({ ...base, kind: "guess", source: "USER_EXPLICIT", normative: true }),
  ).toBe(false);
});

test("ChangeOperation kinds", () => {
  const validator = Compile(ChangeOperationSchema);
  expect(
    validator.Check({
      kind: "create_directory",
      path: "src/new",
      expectedAbsent: true,
    }),
  ).toBe(true);
  expect(
    validator.Check({
      kind: "delete",
      path: "src/old.js",
      expectedBeforeDigest: digest,
    }),
  ).toBe(true);
  expect(validator.Check({ kind: "rename", path: "a" })).toBe(false);
  expect(validator.Check({ kind: "delete", path: "src/old.js" })).toBe(false);
  expect(
    validator.Check({
      kind: "delete",
      path: "src/old.js",
      expectedBeforeDigest: digest,
      extra: true,
    }),
  ).toBe(false);
});

test("CloudResult unknown kind rejects", () => {
  const validator = Compile(CloudResultSchema);
  expect(
    validator.Check({
      schemaVersion: 1,
      runId: run,
      cloudCallId: "call_01234567-89ab-7cde-8f01-23456789abcd",
      requestBindingDigest: digest,
      contextPacketObjectDigest: digest,
      baseSnapshotId: snap,
      baseSnapshotRootDigest: digest,
      kind: "request_context",
      missingClaimIds: [evidence],
      requestedEvidenceKinds: [],
      pathOrSymbolHints: [],
      requestedSkillIds: [],
      reason: "need more graph",
    }),
  ).toBe(true);
  expect(validator.Check({ kind: "chat" })).toBe(false);
});

test("SuccessfulRunResult ApprovalGrant SandboxJobResult OperationResult extra properties", () => {
  rejectExtra(SuccessfulRunResultSchema, {
    schemaVersion: 1,
    runId: run,
    kind: "no_change",
    noChangeReceiptObjectDigest: digest,
    unchangedSnapshotRootDigest: digest,
  });
  rejectExtra(ApprovalGrantSchema, {
    schemaVersion: 1,
    approvalId: "approval_01234567-89ab-7cde-8f01-23456789abcd",
    projectId: "proj1",
    principalId: "user-1",
    challengeObjectDigest: digest,
    approvalDecisionObjectDigest: digest,
    subjectObjectDigest: digest,
    policyObjectDigest: digest,
    issuedAt: "2026-01-02T03:04:05.006Z",
    expiresAt: "2026-01-02T03:06:05.006Z",
    scope: "project",
    action: "project-trust",
  });
  const sandboxValid = {
    schemaVersion: 1,
    outcome: "REJECTED",
    projectId: "proj1",
    runId: run,
    operationId: "op_01234567-89ab-7cde-8f01-23456789abcd",
    leaseGeneration: 1,
    sandboxJobObjectDigest: digest,
    reasonCode: "policy",
    evidenceObjectDigest: digest,
    completedAt: "2026-01-02T03:04:05.006Z",
  };
  expect(Compile(SandboxJobResultSchema).Check(sandboxValid)).toBe(true);
  expect(Compile(SandboxJobResultSchema).Check({ ...sandboxValid, extra: true })).toBe(false);
  expect(
    Compile(OperationResultRequestSchema).Check({
      schemaVersion: 1,
      leaseToken: "token-token-token",
      leaseGeneration: 1,
      outcome: "SUCCEEDED",
      resultObjectDigest: digest,
    }),
  ).toBe(true);
  expect(
    Compile(BrokerRequestSchema).Check({
      requestId: "req-1",
      method: "GET_RUN_STATUS",
      params: { runId: run },
    }),
  ).toBe(true);
  expect(
    Compile(BrokerRequestSchema).Check({
      requestId: "req-1",
      method: "UNKNOWN",
      params: {},
    }),
  ).toBe(false);
  expect(
    Compile(ApprovalSubjectSchema).Check({
      schemaVersion: 1,
      kind: "project-policy",
      projectId: "proj1",
      priorPolicyObjectDigest: digest,
      proposedPolicyObjectDigest: digest,
    }),
  ).toBe(true);
});
