import { expect, test } from "vitest";
import { objectDigestFromBytes } from "@pi-hec/contracts";
import {
  memoryArtifacts,
  memoryHost,
  parseSarif,
  producerIdsForStdout,
  runVerification,
} from "../src/index.js";
import { BINDINGS, CHECK, OBJECT, OBL, commandSpec, emptyPlan, sandboxBinding } from "./helpers.js";

const CHECK2 = "check_" + "d".repeat(52);

const EMPTY_SARIF = JSON.stringify({ version: "2.1.0", runs: [{ results: [] }] });
const GENERIC_RUNS = JSON.stringify({ version: "1.0", runs: [{ id: "job-1" }] });
const INVALID_JSON = '{"version":"2.1.0","runs":[{"results":';
const JUNIT = `<?xml version="1.0"?><testsuite tests="1" failures="1"><testcase name="t"><failure message="x"/></testcase></testsuite>`;

test("generic JSON with runs and version is not routed to SARIF", () => {
  expect(producerIdsForStdout(GENERIC_RUNS)).not.toContain("sarif");
});

test("empty SARIF findings do not SUPPORTS", async () => {
  expect(parseSarif(EMPTY_SARIF)).toEqual([]);
  const stdout = objectDigestFromBytes(Buffer.from(EMPTY_SARIF, "utf8"));
  const check = {
    id: CHECK,
    obligationIds: [OBL],
    subject: "CANDIDATE" as const,
    recipe: { intrinsicCheckId: "sarif-parse", configurationObjectDigest: OBJECT },
    dependencies: [],
    mandatory: true,
    approval: "AUTO" as const,
  };
  const result = await runVerification({
    plan: emptyPlan({ checks: [check] }),
    planObjectDigest: OBJECT,
    evidenceRecords: [],
    host: memoryHost({}),
    artifacts: memoryArtifacts({ [stdout]: EMPTY_SARIF }),
    bindings: BINDINGS,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    observationsByCheck: new Map([
      [
        CHECK,
        [
          {
            attempt: 1,
            state: "PASSED" as const,
            exitCode: 0,
            durationMs: 4,
            stdoutArtifact: stdout,
          },
          {
            attempt: 2,
            state: "PASSED" as const,
            exitCode: 0,
            durationMs: 4,
            stdoutArtifact: stdout,
          },
          {
            attempt: 3,
            state: "PASSED" as const,
            exitCode: 0,
            durationMs: 4,
            stdoutArtifact: stdout,
          },
        ],
      ],
    ]),
  });
  expect(
    result.evidence.some((item) => item.producerId === "sarif" && item.relation === "SUPPORTS"),
  ).toBe(false);
  expect(result.report.obligationResults[0]?.status).not.toBe("PASS");
});

test("invalid JSON parse fails closed and sibling checks continue", async () => {
  expect(parseSarif(INVALID_JSON)).toEqual([]);
  const badOut = objectDigestFromBytes(Buffer.from(INVALID_JSON, "utf8"));
  const goodOut = objectDigestFromBytes(Buffer.from(JUNIT, "utf8"));
  const sarifCheck = {
    id: CHECK,
    obligationIds: [OBL],
    subject: "CANDIDATE" as const,
    recipe: { intrinsicCheckId: "sarif-parse", configurationObjectDigest: OBJECT },
    dependencies: [],
    mandatory: true,
    approval: "AUTO" as const,
  };
  const junitCheck = {
    id: CHECK2,
    obligationIds: [OBL],
    subject: "CANDIDATE" as const,
    recipe: commandSpec({ id: "cmd-junit" }),
    dependencies: [],
    mandatory: true,
    approval: "AUTO" as const,
  };
  const result = await runVerification({
    plan: emptyPlan({ checks: [sarifCheck, junitCheck] }),
    planObjectDigest: OBJECT,
    evidenceRecords: [],
    host: memoryHost({}),
    artifacts: memoryArtifacts({ [badOut]: INVALID_JSON, [goodOut]: JUNIT }),
    bindings: BINDINGS,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    sandboxExecution: sandboxBinding(),
    observationsByCheck: new Map([
      [CHECK, [{ attempt: 1, state: "PASSED" as const, durationMs: 1, stdoutArtifact: badOut }]],
      [
        CHECK2,
        [
          {
            attempt: 1,
            state: "FAILED" as const,
            exitCode: 1,
            durationMs: 2,
            stdoutArtifact: goodOut,
          },
          {
            attempt: 2,
            state: "FAILED" as const,
            exitCode: 1,
            durationMs: 2,
            stdoutArtifact: goodOut,
          },
          {
            attempt: 3,
            state: "FAILED" as const,
            exitCode: 1,
            durationMs: 2,
            stdoutArtifact: goodOut,
          },
        ],
      ],
    ]),
  });
  expect(
    result.evidence.some((item) => item.producerId === "junit" && item.relation === "REFUTES"),
  ).toBe(true);
  expect(result.report.obligationResults[0]?.status).toBe("FAIL");
});
