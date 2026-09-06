import { expect, test } from "vitest";
import { detectGaming, memoryHost, runVerification } from "../src/index.js";
import { BINDINGS, OBJECT, emptyPlan, evidence, stableObservations } from "./helpers.js";
import type { TestDiscovery } from "../src/index.js";

function discovery(overrides: Partial<TestDiscovery> = {}): TestDiscovery {
  return {
    names: ["alpha", "beta"],
    skipped: [],
    focused: [],
    filters: [],
    assertionCount: 4,
    runnerConfigDigest: "sha256:" + "22".repeat(32),
    fixtureDigests: new Map([["tests/fixtures/a.json", "sha256:" + "33".repeat(32)]]),
    exitCode: 0,
    parsedFailed: 0,
    parsedPassed: 2,
    visualGoldensUpdatedByCandidate: false,
    ...overrides,
  };
}

const supporting = evidence({
  id: "ev-support",
  relation: "SUPPORTS",
  origin: "INDEPENDENT_TOOL",
  observations: stableObservations("PASSED"),
});

test("skip filter and focus block an otherwise ACCEPTED plan", async () => {
  const sealed = discovery();
  const candidate = discovery({
    names: ["alpha"],
    skipped: ["beta"],
    focused: ["alpha"],
    filters: ["--grep alpha"],
    assertionCount: 1,
    parsedPassed: 1,
  });
  const findings = detectGaming(sealed, candidate);
  expect(findings.map((item) => item.code)).toEqual(
    expect.arrayContaining(["GAMING_TEST_FILTER", "TEST_SKIP_ADDED", "TEST_WEAKENED"]),
  );
  const clean = await runVerification({
    plan: emptyPlan(),
    planObjectDigest: OBJECT,
    evidenceRecords: [supporting],
    host: memoryHost({}),
    bindings: BINDINGS,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
  });
  expect(clean.report.verdict).toBe("ACCEPTED");
  const gamed = await runVerification({
    plan: emptyPlan(),
    planObjectDigest: OBJECT,
    evidenceRecords: [supporting],
    host: memoryHost({}),
    bindings: BINDINGS,
    subject: { kind: "CHANGESET", candidateManifestObjectDigest: OBJECT },
    integrityViolation: false,
    sealsValid: true,
    gaming: { sealed, candidate },
  });
  expect(gamed.report.verdict).not.toBe("ACCEPTED");
});

test("visual golden updated by candidate does not confirm itself", () => {
  const findings = detectGaming(discovery(), discovery({ visualGoldensUpdatedByCandidate: true }));
  expect(findings.some((item) => item.code === "TEST_SNAPSHOT_SELF_APPROVED")).toBe(true);
});

test("exit 0 with parsed failures is output forgery", () => {
  const findings = detectGaming(discovery(), discovery({ parsedFailed: 2, parsedPassed: 0 }));
  expect(findings.some((item) => item.code === "GAMING_OUTPUT_FORGERY")).toBe(true);
});
