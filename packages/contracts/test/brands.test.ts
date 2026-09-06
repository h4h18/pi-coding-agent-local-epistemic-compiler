import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { assert, constant, constantFrom, integer, oneof, property, string, tuple } from "fast-check";
import { expect, test } from "vitest";
import {
  ApprovalIdSchema,
  BrandError,
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
  asApprovalId,
  asCandidateId,
  asCheckId,
  asCloudCallId,
  asDigest,
  asEvidenceId,
  asEvidenceIds,
  asObjectDigest,
  asObligationId,
  asOperationId,
  asPayloadDigest,
  asRequirementId,
  asRunId,
  asSnapshotId,
  isApprovalId,
  isCandidateId,
  isCheckId,
  isCloudCallId,
  isDigest,
  isEvidenceId,
  isObjectDigest,
  isObligationId,
  isOperationId,
  isPayloadDigest,
  isRequirementId,
  isRunId,
  isSnapshotId,
} from "../src/ids.js";
import { APPROVAL, CALL, CANDIDATE, DIGEST, EVIDENCE, OP, REQ, RUN, SNAP } from "./helpers.js";

const UUID_BODY = "01234567-89ab-7cde-8f01-23456789abcd";
const CROCKFORD = "a".repeat(52);
const OBLIGATION = `obl_${CROCKFORD}`;
const CHECK = `check_${CROCKFORD}`;

type Brand = {
  name: string;
  guard: (value: string) => boolean;
  construct: (value: string) => string;
  schema: TSchema;
  valid: string;
  invalid: readonly string[];
};

const BRANDS: readonly Brand[] = [
  {
    name: "digest",
    guard: isDigest,
    construct: asDigest,
    schema: DigestSchema,
    valid: DIGEST,
    invalid: ["sha256:" + "AB".repeat(32), "sha256:" + "ab".repeat(31), "sha1:" + "ab".repeat(32), ""],
  },
  {
    name: "object digest",
    guard: isObjectDigest,
    construct: asObjectDigest,
    schema: DigestSchema,
    valid: DIGEST,
    invalid: ["sha256:" + "ab".repeat(32) + "a", "ab".repeat(32)],
  },
  {
    name: "payload digest",
    guard: isPayloadDigest,
    construct: asPayloadDigest,
    schema: DigestSchema,
    valid: DIGEST,
    invalid: ["sha256:" + "gg".repeat(32)],
  },
  {
    name: "run id",
    guard: isRunId,
    construct: asRunId,
    schema: RunIdSchema,
    valid: RUN,
    invalid: [
      `run_${UUID_BODY.toUpperCase()}`,
      "run_01234567-89ab-4cde-8f01-23456789abcd",
      "run_01234567-89ab-7cde-0f01-23456789abcd",
      `op_${UUID_BODY}`,
      "run_",
    ],
  },
  {
    name: "operation id",
    guard: isOperationId,
    construct: asOperationId,
    schema: OperationIdSchema,
    valid: OP,
    invalid: [`run_${UUID_BODY}`, `op_${UUID_BODY}x`],
  },
  {
    name: "snapshot id",
    guard: isSnapshotId,
    construct: asSnapshotId,
    schema: SnapshotIdSchema,
    valid: SNAP,
    invalid: [`snapshot_${UUID_BODY}`, `snap_${UUID_BODY.replace("-", "")}`],
  },
  {
    name: "cloud call id",
    guard: isCloudCallId,
    construct: asCloudCallId,
    schema: CloudCallIdSchema,
    valid: CALL,
    invalid: [`call_${UUID_BODY.slice(1)}`],
  },
  {
    name: "candidate id",
    guard: isCandidateId,
    construct: asCandidateId,
    schema: CandidateIdSchema,
    valid: CANDIDATE,
    invalid: [`cand_${UUID_BODY}`],
  },
  {
    name: "approval id",
    guard: isApprovalId,
    construct: asApprovalId,
    schema: ApprovalIdSchema,
    valid: APPROVAL,
    invalid: [`approval-${UUID_BODY}`],
  },
  {
    name: "evidence id",
    guard: isEvidenceId,
    construct: asEvidenceId,
    schema: EvidenceIdSchema,
    valid: EVIDENCE,
    invalid: [`evidence_${"A".repeat(52)}`, `evidence_${"a".repeat(51)}`, `evidence_${"0".repeat(52)}`, REQ],
  },
  {
    name: "requirement id",
    guard: isRequirementId,
    construct: asRequirementId,
    schema: RequirementIdSchema,
    valid: REQ,
    invalid: [`req_${"a".repeat(53)}`, `req_${"1".repeat(52)}`, EVIDENCE],
  },
  {
    name: "obligation id",
    guard: isObligationId,
    construct: asObligationId,
    schema: ObligationIdSchema,
    valid: OBLIGATION,
    invalid: [`obl_${"8".repeat(52)}`, `obligation_${CROCKFORD}`],
  },
  {
    name: "check id",
    guard: isCheckId,
    construct: asCheckId,
    schema: CheckIdSchema,
    valid: CHECK,
    invalid: [`check_${"9".repeat(52)}`, `chk_${CROCKFORD}`],
  },
];

test.each(BRANDS)("$name guard accepts the canonical form and rejects malformed input", (brand) => {
  expect(brand.guard(brand.valid)).toBe(true);
  for (const value of brand.invalid) {
    expect(brand.guard(value)).toBe(false);
  }
});

test.each(BRANDS)("$name constructor returns the input unchanged or throws BrandError", (brand) => {
  expect(brand.construct(brand.valid)).toBe(brand.valid);
  for (const value of brand.invalid) {
    let caught: unknown;
    try {
      brand.construct(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrandError);
    if (caught instanceof BrandError) {
      expect(caught.name).toBe("BrandError");
      expect(caught.brand).toBe(brand.name);
      expect(caught.value).toBe(value);
      expect(caught.message).toBe(`invalid ${brand.name}: ${JSON.stringify(value)}`);
    }
  }
});

test.each(BRANDS)("$name guard agrees with the TypeBox schema on arbitrary strings", (brand) => {
  const validator = Compile(brand.schema);
  const nearMiss = tuple(
    integer({ min: 0, max: brand.valid.length - 1 }),
    string({ unit: "binary-ascii", minLength: 1, maxLength: 1 }),
  ).map(([index, replacement]) => brand.valid.slice(0, index) + replacement + brand.valid.slice(index + 1));
  assert(
    property(
      oneof(string({ unit: "binary" }), constant(brand.valid), nearMiss, constantFrom(...brand.invalid)),
      (value) => {
        expect(brand.guard(value)).toBe(validator.Check(value));
      },
    ),
    { numRuns: 500 },
  );
});

test("asEvidenceIds brands every element and reports the first offender", () => {
  const second = `evidence_${"b".repeat(52)}`;
  expect(asEvidenceIds([EVIDENCE, second])).toEqual([EVIDENCE, second]);
  expect(asEvidenceIds([])).toEqual([]);
  let caught: unknown;
  try {
    asEvidenceIds([EVIDENCE, REQ, "evidence_"]);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BrandError);
  if (caught instanceof BrandError) {
    expect(caught.value).toBe(REQ);
  }
});
