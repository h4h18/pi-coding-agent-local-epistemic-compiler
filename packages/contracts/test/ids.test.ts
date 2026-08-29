import { expect, test } from "vitest";
import { Compile } from "typebox/compile";
import {
  ApprovalIdSchema,
  CandidateIdSchema,
  CheckIdSchema,
  CloudCallIdSchema,
  DigestSchema,
  EvidenceIdSchema,
  ObligationIdSchema,
  OperationIdSchema,
  RequirementIdSchema,
  RunIdSchema,
  SnapshotIdSchema,
  TimestampSchema,
  isPrefixedUuidV7,
} from "../src/ids.js";

const digest = "sha256:" + "ab".repeat(32);
const uuidBody = "01234567-89ab-7cde-8f01-23456789abcd";
const crockford = "a".repeat(52);

test("digest schema accepts lowercase sha256 and rejects uppercase", () => {
  const validator = Compile(DigestSchema);
  expect(validator.Check(digest)).toBe(true);
  expect(validator.Check("sha256:" + "AB".repeat(32))).toBe(false);
  expect(validator.Check("sha256:short")).toBe(false);
});

test("uuid v7 ids accept canonical lowercase and reject uppercase or wrong version", () => {
  const runId = `run_${uuidBody}`;
  expect(Compile(RunIdSchema).Check(runId)).toBe(true);
  expect(Compile(OperationIdSchema).Check(`op_${uuidBody}`)).toBe(true);
  expect(Compile(SnapshotIdSchema).Check(`snap_${uuidBody}`)).toBe(true);
  expect(Compile(CloudCallIdSchema).Check(`call_${uuidBody}`)).toBe(true);
  expect(Compile(CandidateIdSchema).Check(`candidate_${uuidBody}`)).toBe(true);
  expect(Compile(ApprovalIdSchema).Check(`approval_${uuidBody}`)).toBe(true);
  expect(Compile(RunIdSchema).Check(`run_${uuidBody.toUpperCase()}`)).toBe(false);
  expect(Compile(RunIdSchema).Check("run_01234567-89ab-4cde-8f01-23456789abcd")).toBe(false);
  expect(Compile(RunIdSchema).Check("run_01234567-89ab-7cde-0f01-23456789abcd")).toBe(false);
  expect(isPrefixedUuidV7("run_", runId)).toBe(true);
  expect(isPrefixedUuidV7("run_", `run_${uuidBody.toUpperCase()}`)).toBe(false);
});

test("crockford ids use lowercase base32 without 0189", () => {
  expect(Compile(EvidenceIdSchema).Check(`evidence_${crockford}`)).toBe(true);
  expect(Compile(RequirementIdSchema).Check(`req_${crockford}`)).toBe(true);
  expect(Compile(ObligationIdSchema).Check(`obl_${crockford}`)).toBe(true);
  expect(Compile(CheckIdSchema).Check(`check_${crockford}`)).toBe(true);
  expect(Compile(EvidenceIdSchema).Check("evidence_" + "1".repeat(52))).toBe(false);
  expect(Compile(EvidenceIdSchema).Check("evidence_" + "A".repeat(52))).toBe(false);
});

test("timestamp rejects leap seconds and non-canonical forms", () => {
  const validator = Compile(TimestampSchema);
  expect(validator.Check("2026-01-02T03:04:05.006Z")).toBe(true);
  expect(validator.Check("2026-01-02T03:04:05Z")).toBe(false);
  expect(validator.Check("2026-06-30T23:59:60.000Z")).toBe(false);
});
