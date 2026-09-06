import { Compile } from "typebox/compile";
import { expect, test } from "vitest";
import { SandboxJobSchema } from "@pi-hec/contracts";
import {
  approvalForCommand,
  buildSignedSandboxJob,
  executionGate,
  memoryHost,
  networkCapabilityUnavailableExecutor,
  runVerification,
} from "../src/index.js";
import { BINDINGS, CHECK, OBJECT, OBL, commandSpec, emptyPlan, keyPair, obligation, sandboxBinding } from "./helpers.js";

const JOB = Compile(SandboxJobSchema);

test("execution binds ResolvedCommandSpec into a signed SandboxJob", async () => {
  const spec = commandSpec();
  const check = {
    id: CHECK,
    obligationIds: [OBL],
    subject: "CANDIDATE" as const,
    recipe: spec,
    dependencies: [],
    mandatory: true,
    approval: approvalForCommand(spec),
  };
  const signer = keyPair();
  const binding = sandboxBinding(signer);
  const signed = buildSignedSandboxJob(spec, check, binding);
  expect(JOB.Check(signed.jobEnvelope.payload)).toBe(true);
  expect(signed.jobEnvelope.schemaName).toBe("SandboxJob");
  expect(signed.resolved.executablePath).toBe("usr/bin/test-runner");
  expect(signed.jobEnvelope.payload).toMatchObject({
    resolvedCommandSpecObjectDigest: signed.resolvedEnvelopeDigest,
  });
  let ran = 0;
  const result = await runVerification({
    plan: { ...emptyPlan(), checks: [check] },
    planObjectDigest: OBJECT,
    evidenceRecords: [],
    host: memoryHost({}),
    bindings: BINDINGS,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    sandboxExecution: binding,
    sandbox: {
      run(input) {
        ran += 1;
        expect(input.jobEnvelope.schemaName).toBe("SandboxJob");
        expect(input.resolvedEnvelopeDigest).toBe(signed.resolvedEnvelopeDigest);
        expect(input.resolved.executablePath).toBe("usr/bin/test-runner");
        expect(JOB.Check(input.jobEnvelope.payload)).toBe(true);
        return {
          outcome: "COMPLETED",
          exitCode: 0,
          observations: [{ attempt: 1, state: "PASSED", exitCode: 0, durationMs: 5 }],
        };
      },
    },
  });
  expect(ran).toBe(1);
  expect(result.report.verdict).not.toBe("REJECTED");
});

test("CLOUD_PROPOSED stays REQUIRE_USER and is not auto-executed", async () => {
  const spec = commandSpec({ authority: "CLOUD_PROPOSED" });
  expect(approvalForCommand(spec)).toBe("REQUIRE_USER");
  expect(executionGate("REQUIRE_USER")).toBe("wait");
  const check = {
    id: CHECK,
    obligationIds: [OBL],
    subject: "CANDIDATE" as const,
    recipe: spec,
    dependencies: [],
    mandatory: true,
    approval: approvalForCommand(spec),
  };
  expect(check.approval).toBe("REQUIRE_USER");
  let ran = 0;
  const result = await runVerification({
    plan: { ...emptyPlan(), checks: [check], obligations: [obligation()] },
    planObjectDigest: OBJECT,
    evidenceRecords: [],
    host: memoryHost({}),
    bindings: BINDINGS,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    sandboxExecution: sandboxBinding(),
    sandbox: {
      run() {
        ran += 1;
        throw new Error("CLOUD_PROPOSED must not execute");
      },
    },
  });
  expect(ran).toBe(0);
  expect(result.report.verdict).toBe("INCONCLUSIVE");
  expect(result.report.obligationResults[0]?.status).toBe("UNKNOWN");
});

test("DENY approval does not execute", async () => {
  const spec = commandSpec();
  const check = {
    id: CHECK,
    obligationIds: [OBL],
    subject: "CANDIDATE" as const,
    recipe: spec,
    dependencies: [],
    mandatory: true,
    approval: "DENY" as const,
  };
  let ran = 0;
  await runVerification({
    plan: { ...emptyPlan(), checks: [check] },
    planObjectDigest: OBJECT,
    evidenceRecords: [],
    host: memoryHost({}),
    bindings: BINDINGS,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    sandboxExecution: sandboxBinding(),
    sandbox: {
      run() {
        ran += 1;
        throw new Error("DENY must not execute");
      },
    },
  });
  expect(ran).toBe(0);
});

test("network-capability sandbox jobs return UNKNOWN and never host-exec", async () => {
  const executor = networkCapabilityUnavailableExecutor();
  const spec = commandSpec({ network: "DECLARED_ENDPOINTS" });
  const signed = buildSignedSandboxJob(
    spec,
    {
      id: CHECK,
      obligationIds: [OBL],
      subject: "CANDIDATE",
      recipe: spec,
      dependencies: [],
      mandatory: true,
      approval: "AUTO",
    },
    sandboxBinding(),
  );
  const result = await executor.run({
    spec,
    resolved: signed.resolved,
    resolvedEnvelopeDigest: signed.resolvedEnvelopeDigest,
    jobEnvelope: signed.jobEnvelope,
    networkRequired: true,
  });
  expect(result.outcome).toBe("OUTCOME_UNKNOWN");
  if (result.outcome !== "OUTCOME_UNKNOWN") {
    throw new Error("expected OUTCOME_UNKNOWN");
  }
  expect(result.reason).toBe("pi-hec-sb-net-unavailable");
  expect(result.observations[0]?.state).toBe("ERROR");
});
