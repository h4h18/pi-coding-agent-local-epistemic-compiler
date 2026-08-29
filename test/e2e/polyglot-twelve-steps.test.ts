import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  runPolyglotTwelveSteps,
  writePolyglotFixture,
  type PolyglotPorts,
} from "./polyglot-harness.js";

function injectedPorts(fixture: ReturnType<typeof writePolyglotFixture>): PolyglotPorts {
  return {
    snapshot: () => ({
      dirtyPaths: ["service/app.py", "service/test_app.py", "AGENTS.md", "generated/bundle.js"],
      generatedPath: fixture.generatedPath,
      generatedDigest: createHash("sha256").update(readFileSync(fixture.generatedPath)).digest("hex"),
    }),
    preflight: (snapshot) => ({
      failingTest: "service/test_app.py",
      callers: ["service/app.py"],
      agentsPath: "AGENTS.md",
      generatedExclusion: snapshot.generatedPath,
    }),
    oneShot: () => ({ tool: "submit_solution", acceptedCompletions: 1 }),
    sandbox: () => ({
      appliedInVm: true,
      hostTreeDigestUnchanged: true,
      baseline: "FAIL",
      candidate: "PASS",
    }),
    verdict: () => "ACCEPTED",
    usage: () => ({ acceptedCompletionCount: 1 }),
    apply: (input) => {
      if (!input.trustedUi) {
        throw new Error("apply requires trusted UI");
      }
      return {
        changedPaths: input.intendedPaths,
        generatedDigestAfter: createHash("sha256").update(readFileSync(input.generatedPath)).digest("hex"),
      };
    },
  };
}

test("section 39 twelve steps pass with injected ports and one accepted completion", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hec-e2e-poly-"));
  const fixture = writePolyglotFixture(root);
  const result = await runPolyglotTwelveSteps(injectedPorts(fixture));
  expect(result.steps).toHaveLength(12);
  expect(result.steps.every((step) => step.ok)).toBe(true);
  expect(result.verdict).toBe("ACCEPTED");
  expect(result.acceptedCompletions).toBe(1);
  const onDisk = createHash("sha256").update(readFileSync(fixture.generatedPath)).digest("hex");
  expect(result.generatedDigest).toBe(onDisk);
  expect(result.runId.startsWith("run_")).toBe(true);
});
