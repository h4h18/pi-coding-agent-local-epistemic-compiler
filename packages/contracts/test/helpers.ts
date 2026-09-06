import { type TSchema } from "typebox";
import { expect } from "vitest";
import { Compile } from "typebox/compile";

export const DIGEST = "sha256:" + "ab".repeat(32);
export const SNAP = "snap_01234567-89ab-7cde-8f01-23456789abcd";
export const RUN = "run_01234567-89ab-7cde-8f01-23456789abcd";
export const CALL = "call_01234567-89ab-7cde-8f01-23456789abcd";
export const OP = "op_01234567-89ab-7cde-8f01-23456789abcd";
export const APPROVAL = "approval_01234567-89ab-7cde-8f01-23456789abcd";
export const CANDIDATE = "candidate_01234567-89ab-7cde-8f01-23456789abcd";
export const REQ = "req_" + "a".repeat(52);
export const EVIDENCE = "evidence_" + "a".repeat(52);
export const TS = "2026-01-02T03:04:05.006Z";
export const PROJ = "proj1";
export const BASE64 = "aGk=";

export function acceptAndRejectExtra(schema: TSchema, valid: Record<string, unknown>): void {
  const validator = Compile(schema);
  expect(validator.Check(valid)).toBe(true);
  expect(validator.Check({ ...valid, extra: true })).toBe(false);
}

export const posixMeta = {
  kind: "posix" as const,
  device: "dev1",
  inode: "ino1",
  mode: 33188,
  ownerId: 0,
  groupId: 0,
  xattrsDigest: DIGEST,
};

export const cloudResultBinding = {
  schemaVersion: 1 as const,
  runId: RUN,
  cloudCallId: CALL,
  requestBindingDigest: DIGEST,
  contextPacketObjectDigest: DIGEST,
  baseSnapshotId: SNAP,
  baseSnapshotRootDigest: DIGEST,
};

export const initialRequestBinding = {
  schemaVersion: 1 as const,
  purpose: "initial" as const,
  runId: RUN,
  cloudCallId: CALL,
  contextPacketObjectDigest: DIGEST,
  baseSnapshotId: SNAP,
  baseSnapshotRootDigest: DIGEST,
  deploymentId: PROJ,
  adapterVersionObjectDigest: DIGEST,
  modelRevision: "model-1",
  resultSchemaObjectDigest: DIGEST,
};
