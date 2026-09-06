import { expect, test } from "vitest";
import { objectDigestFromBytes } from "@pi-hec/contracts";
import {
  memoryArtifacts,
  memoryHost,
  parseJunitXml,
  runVerification,
} from "../src/index.js";
import { BINDINGS, CHECK, OBJECT, OBL, commandSpec, emptyPlan, obligation, sandboxBinding } from "./helpers.js";

const XML = `<?xml version="1.0"?>
<testsuite tests="2" failures="1">
  <testcase classname="T" name="ok" assertions="1"/>
  <testcase classname="T" name="bad" assertions="1"><failure message="nope"/></testcase>
</testsuite>`;

test("JUnit stdout from a command check is routed to the JUnit parser in runVerification", async () => {
  expect(parseJunitXml(XML).some((item) => item.status === "failed")).toBe(true);
  const stdout = objectDigestFromBytes(Buffer.from(XML, "utf8"));
  const spec = commandSpec({ argv: ["--reporter", "junit"] });
  const check = {
    id: CHECK,
    obligationIds: [OBL],
    subject: "CANDIDATE" as const,
    recipe: spec,
    dependencies: [],
    mandatory: true,
    approval: "AUTO" as const,
  };
  const result = await runVerification({
    plan: { ...emptyPlan(), checks: [check], obligations: [obligation()] },
    planObjectDigest: OBJECT,
    evidenceRecords: [],
    host: memoryHost({}),
    artifacts: memoryArtifacts({ [stdout]: XML }),
    bindings: BINDINGS,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    sandboxExecution: sandboxBinding(),
    sandbox: {
      run(input) {
        expect(input.jobEnvelope.schemaName).toBe("SandboxJob");
        return {
          outcome: "COMPLETED",
          exitCode: 1,
          observations: [
            {
              attempt: 1,
              state: "FAILED",
              exitCode: 1,
              durationMs: 8,
              stdoutArtifact: stdout,
            },
            {
              attempt: 2,
              state: "FAILED",
              exitCode: 1,
              durationMs: 8,
              stdoutArtifact: stdout,
            },
            {
              attempt: 3,
              state: "FAILED",
              exitCode: 1,
              durationMs: 8,
              stdoutArtifact: stdout,
            },
          ],
        };
      },
    },
  });
  expect(result.evidence.some((item) => item.producerId === "junit" && item.relation === "REFUTES")).toBe(true);
  expect(result.report.obligationResults[0]?.status).toBe("FAIL");
  expect(result.report.verdict).toBe("REJECTED");
});
