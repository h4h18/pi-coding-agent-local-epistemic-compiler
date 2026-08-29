import { expect, test } from "vitest";
import { evaluateRedGreen, memoryHost, runVerification } from "../src/index.js";
import { BINDINGS, OBJECT, emptyPlan, obligation, observation } from "./helpers.js";

test("new candidate test must fail on baseline then pass on candidate", () => {
  const result = evaluateRedGreen({
    name: "reproduces the bug",
    bytesDigest: "sha256:" + "11".repeat(32),
    baselineObservations: [observation("FAILED")],
    candidateObservations: [observation("PASSED")],
    targetsRequirement: true,
    importFailure: false,
    requirementAddsPublicSymbol: false,
  });
  expect(result).toBe("reproduction");
});

test("baseline-passing test is not reproduction evidence", () => {
  const result = evaluateRedGreen({
    name: "already green",
    bytesDigest: "sha256:" + "11".repeat(32),
    baselineObservations: [observation("PASSED")],
    candidateObservations: [observation("PASSED")],
    targetsRequirement: true,
    importFailure: false,
    requirementAddsPublicSymbol: false,
  });
  expect(result).toBe("not-reproduction");
});

test("import failure is wrong red unless the requirement adds a public symbol", () => {
  expect(
    evaluateRedGreen({
      name: "import",
      bytesDigest: "sha256:" + "11".repeat(32),
      baselineObservations: [observation("FAILED")],
      candidateObservations: [observation("PASSED")],
      targetsRequirement: true,
      importFailure: true,
      requirementAddsPublicSymbol: false,
    }),
  ).toBe("wrong-red-reason");
});

test("successful red-green reproduction can PASS the obligation via runVerification", async () => {
  const result = await runVerification({
    plan: emptyPlan({ obligations: [obligation()] }),
    planObjectDigest: OBJECT,
    evidenceRecords: [],
    host: memoryHost({}),
    bindings: BINDINGS,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    redGreen: [
      {
        name: "reproduces the bug",
        bytesDigest: "sha256:" + "11".repeat(32),
        baselineObservations: [observation("FAILED")],
        candidateObservations: [observation("PASSED")],
        targetsRequirement: true,
        importFailure: false,
        requirementAddsPublicSymbol: false,
      },
    ],
  });
  expect(result.evidence.some((item) => item.oracle === "RED_GREEN" && item.relation === "SUPPORTS")).toBe(true);
  expect(result.report.obligationResults[0]?.status).toBe("PASS");
  expect(result.report.verdict).toBe("ACCEPTED");
});

test("baseline-passing red-green does not PASS as reproduction", async () => {
  const result = await runVerification({
    plan: emptyPlan(),
    planObjectDigest: OBJECT,
    evidenceRecords: [],
    host: memoryHost({}),
    bindings: BINDINGS,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    redGreen: [
      {
        name: "already green",
        bytesDigest: "sha256:" + "11".repeat(32),
        baselineObservations: [observation("PASSED")],
        candidateObservations: [observation("PASSED")],
        targetsRequirement: true,
        importFailure: false,
        requirementAddsPublicSymbol: false,
      },
    ],
  });
  expect(result.evidence.some((item) => item.oracle === "RED_GREEN" && item.relation === "SUPPORTS")).toBe(false);
  expect(result.report.obligationResults[0]?.status).toBe("UNKNOWN");
});
