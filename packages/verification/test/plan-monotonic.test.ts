import { assert, property, string } from "fast-check";
import { expect, test } from "vitest";
import {
  PlanError,
  approvalForCommand,
  assertMonotonic,
  bindCommandSpecEnvelope,
  buildP0,
  memoryHost,
  obligationFromRequirement,
  resolveCommandSpec,
  revisePlan,
} from "../src/index.js";
import { BINDINGS, OBJECT, TS, commandSpec, keyPair, requirement, seal } from "./helpers.js";

test("P0 builds a DAG from requirements to obligations to checks", async () => {
  const plan = await buildP0({
    seal: seal(),
    requirements: [requirement()],
    host: memoryHost({ "src/app.ts": "export const n = 1;\n" }, [commandSpec()]),
    bindings: BINDINGS,
  });
  expect(plan.revision).toBe(0);
  expect(plan.obligations).toHaveLength(1);
  expect(plan.checks.length).toBeGreaterThan(0);
  expect(plan.previousPlanObjectDigest).toBeUndefined();
});

test("P1 is monotonic union and records previousPlanObjectDigest", async () => {
  const p0 = await buildP0({
    seal: seal(),
    requirements: [requirement()],
    host: memoryHost({ "src/app.ts": "export const n = 1;\n" }),
    bindings: BINDINGS,
  });
  const extra = obligationFromRequirement({
    ...requirement(),
    id: ("req_" + "c".repeat(52)),
    text: "added coverage obligation",
  });
  const revised = revisePlan({
    previous: p0,
    previousPlanObjectDigest: OBJECT,
    delta: { obligations: [extra] },
    baselineReproducible: true,
    now: TS,
    environmentSealObjectDigest: OBJECT,
  });
  expect(revised.plan.revision).toBe(1);
  expect(revised.plan.previousPlanObjectDigest).toBe(OBJECT);
  expect(revised.plan.obligations.length).toBeGreaterThan(p0.obligations.length);
  assertMonotonic(p0, revised.plan);
});

test("removing an obligation is rejected", async () => {
  const p0 = await buildP0({
    seal: seal(),
    requirements: [requirement()],
    host: memoryHost({ "src/app.ts": "ok\n" }),
    bindings: BINDINGS,
  });
  expect(() => { assertMonotonic(p0, { ...p0, obligations: [] }); }).toThrow(PlanError);
  try {
    assertMonotonic(p0, { ...p0, obligations: [] });
  } catch (error) {
    expect(error).toBeInstanceOf(PlanError);
    expect((error as PlanError).code).toBe("NON_MONOTONIC_REMOVE");
  }
});

test("weakening mandatory is rejected", async () => {
  const p0 = await buildP0({
    seal: seal(),
    requirements: [requirement()],
    host: memoryHost({ "src/app.ts": "ok\n" }),
    bindings: BINDINGS,
  });
  const weakened = p0.obligations.map((item) => ({ ...item, mandatory: false }));
  expect(() =>
    revisePlan({
      previous: p0,
      previousPlanObjectDigest: OBJECT,
      delta: { obligations: weakened },
      baselineReproducible: true,
      now: TS,
      environmentSealObjectDigest: OBJECT,
    }),
  ).toThrow(/WEAKEN_MANDATORY/);
});

test("late paired check without reproducible baseline is rejected", async () => {
  const p0 = await buildP0({
    seal: seal(),
    requirements: [requirement()],
    host: memoryHost({ "src/app.ts": "ok\n" }),
    bindings: BINDINGS,
  });
  const seed = p0.checks[0];
  expect(seed).toBeDefined();
  if (seed === undefined) {
    throw new Error("p0 has no checks");
  }
  const extraCheck = {
    ...seed,
    id: ("check_" + "d".repeat(52)),
    subject: "PAIRED" as const,
  };
  expect(() =>
    revisePlan({
      previous: p0,
      previousPlanObjectDigest: OBJECT,
      delta: { checks: [extraCheck] },
      baselineReproducible: false,
      now: TS,
      environmentSealObjectDigest: OBJECT,
    }),
  ).toThrow(/BASELINE_NOT_REPRODUCIBLE/);
});

test("paired late checks emit BaselineSupplement and do not rewrite the seal digest", async () => {
  const p0 = await buildP0({
    seal: seal(),
    requirements: [requirement()],
    host: memoryHost({ "src/app.ts": "ok\n" }),
    bindings: BINDINGS,
  });
  const seed = p0.checks[0];
  expect(seed).toBeDefined();
  if (seed === undefined) {
    throw new Error("p0 has no checks");
  }
  const extraCheck = {
    ...seed,
    id: ("check_" + "e".repeat(52)),
    subject: "PAIRED" as const,
  };
  const revised = revisePlan({
    previous: p0,
    previousPlanObjectDigest: OBJECT,
    delta: { checks: [extraCheck] },
    baselineReproducible: true,
    now: TS,
    environmentSealObjectDigest: OBJECT,
  });
  expect(revised.plan.baselineSealObjectDigest).toBe(p0.baselineSealObjectDigest);
  expect(revised.supplements.length).toBeGreaterThan(0);
  expect(revised.supplements[0]?.reason).toBe("CANDIDATE_DISCOVERED_PAIRED_CHECK");
});

test("CLOUD_PROPOSED commands are never auto-approved and PATH is ignored", () => {
  const keys = keyPair();
  const spec = commandSpec({ authority: "CLOUD_PROPOSED", executable: "usr/bin/test-runner" });
  const bound = bindCommandSpecEnvelope(spec, keys.privateKey, keys.keyId, keys.certDigest, TS);
  expect(bound.digest.startsWith("sha256:")).toBe(true);
  expect(() =>
    resolveCommandSpec(spec, bound.digest, {
      files: new Map(),
      sandboxImageObjectDigest: OBJECT,
      safetyProfileObjectDigest: OBJECT,
    }),
  ).toThrow(/EXECUTABLE_NOT_IN_IMAGE/);
  const resolved = resolveCommandSpec(spec, bound.digest, {
    files: new Map([["usr/bin/test-runner", OBJECT]]),
    sandboxImageObjectDigest: OBJECT,
    safetyProfileObjectDigest: OBJECT,
  });
  expect(resolved.environment).toEqual({});
  expect(resolved.executablePath).toBe("usr/bin/test-runner");
  expect(approvalForCommand(spec)).toBe("REQUIRE_USER");
});

test("property: adding obligations never drops P0 ids", async () => {
  const p0 = await buildP0({
    seal: seal(),
    requirements: [requirement()],
    host: memoryHost({ "src/app.ts": "ok\n" }),
    bindings: BINDINGS,
  });
  assert(
    property(string({ minLength: 1, maxLength: 12 }), (claim) => {
      const extra = obligationFromRequirement({
        ...requirement(),
        id: ("req_" + "f".repeat(52)),
        text: claim,
      });
      const revised = revisePlan({
        previous: p0,
        previousPlanObjectDigest: OBJECT,
        delta: { obligations: [extra] },
        baselineReproducible: true,
        now: TS,
        environmentSealObjectDigest: OBJECT,
      });
      return p0.obligations.every((item) => revised.plan.obligations.some((next) => next.id === item.id));
    }),
  );
});
