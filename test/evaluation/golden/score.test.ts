import { rmSync } from "node:fs";
import { expect, test } from "vitest";
import { applyEdits } from "./apply.js";
import { goldenTask, materializeGoldenRepo } from "./catalog.js";
import { completeTrial } from "./metrics.js";
import { scoreOracle } from "./score.js";
import { SERIALIZED_SESSION } from "./sources.js";
import type { TrialObservation } from "./types.js";

function observation(
  overrides: Partial<TrialObservation> = {},
): TrialObservation {
  return {
    declaredDisposition: "READY",
    statesVisited: ["VERIFIED_ACCEPTED"],
    repairCount: 0,
    userInputCount: 0,
    recovered: false,
    recoveryAttempted: false,
    evidencePresent: ["regression-test", "review-findings", "investigation-report", "command-evidence", "spec-update", "migration-file"],
    cost: 0.02,
    latencyMs: 40,
    firstPass: true,
    ...overrides,
  };
}

test("gold solver for the node-backend bug is accepted and not a false READY", () => {
  const task = goldenTask("golden/node-backend/bug");
  const materialized = materializeGoldenRepo("node-backend");
  try {
    applyEdits(materialized.root, task.oracle.solverEdits);
    const score = scoreOracle({
      task,
      materialized,
      observation: observation(),
    });
    const trial = completeTrial(task.taskId, task.repoId, task.kind, observation(), score);
    expect(score.mustChangeMisses).toEqual([]);
    expect(score.forbiddenTouched).toEqual([]);
    expect(score.requiredBehavior.every((item) => item.passed)).toBe(true);
    expect(score.forbiddenBehavior.every((item) => item.passed)).toBe(true);
    expect(score.acceptanceSuccess).toBe(true);
    expect(trial.falseReady).toBe(false);
    expect(trial.firstPassSuccess).toBe(true);
  } finally {
    rmSync(materialized.root, { recursive: true, force: true });
  }
});

test("READY with global request serialization is a false READY", () => {
  const task = goldenTask("golden/node-backend/bug");
  const materialized = materializeGoldenRepo("node-backend");
  try {
    applyEdits(materialized.root, { [materialized.paths.session]: SERIALIZED_SESSION });
    const ready = observation();
    const score = scoreOracle({ task, materialized, observation: ready });
    const trial = completeTrial(task.taskId, task.repoId, task.kind, ready, score);
    expect(score.acceptanceSuccess).toBe(false);
    expect(trial.falseReady).toBe(true);
    expect(
      score.forbiddenBehavior.some(
        (item) => item.id === "global-request-serialization" && !item.passed,
      ),
    ).toBe(true);
  } finally {
    rmSync(materialized.root, { recursive: true, force: true });
  }
});

test("honest BLOCKED on a wrong patch is not a false READY", () => {
  const task = goldenTask("golden/node-backend/bug");
  const materialized = materializeGoldenRepo("node-backend");
  try {
    const blocked = observation({ declaredDisposition: "BLOCKED", runState: "BLOCKED" });
    const score = scoreOracle({ task, materialized, observation: blocked });
    const trial = completeTrial(task.taskId, task.repoId, task.kind, blocked, score);
    expect(score.acceptanceSuccess).toBe(false);
    expect(trial.falseReady).toBe(false);
  } finally {
    rmSync(materialized.root, { recursive: true, force: true });
  }
});

test("touching public API fails scope and forbids the contract break", () => {
  const task = goldenTask("golden/node-backend/bug");
  const materialized = materializeGoldenRepo("node-backend");
  try {
    applyEdits(materialized.root, {
      ...task.oracle.solverEdits,
      [materialized.paths.publicApi]: "export const broken = true;\n",
    });
    const score = scoreOracle({
      task,
      materialized,
      observation: observation(),
    });
    expect(score.forbiddenTouched).toContain(materialized.paths.publicApi);
    expect(score.acceptanceSuccess).toBe(false);
    expect(score.scopePrecision).toBeLessThan(1);
  } finally {
    rmSync(materialized.root, { recursive: true, force: true });
  }
});

test("incomplete AGENTS.md treats READY as false READY even with a gold patch", () => {
  const task = goldenTask("golden/incomplete-agents/bug");
  expect(task.oracle.expectedDisposition).toBe("BLOCKED");
  const materialized = materializeGoldenRepo("incomplete-agents");
  try {
    applyEdits(materialized.root, task.oracle.solverEdits);
    const ready = observation();
    const score = scoreOracle({ task, materialized, observation: ready });
    const trial = completeTrial(task.taskId, task.repoId, task.kind, ready, score);
    expect(trial.falseReady).toBe(true);
    const blocked = observation({ declaredDisposition: "BLOCKED", runState: "BLOCKED" });
    const honest = scoreOracle({ task, materialized, observation: blocked });
    expect(completeTrial(task.taskId, task.repoId, task.kind, blocked, honest).falseReady).toBe(
      false,
    );
  } finally {
    rmSync(materialized.root, { recursive: true, force: true });
  }
});

test("dirty working tree notes must stay untouched", () => {
  const task = goldenTask("golden/dirty-tree/bug");
  const materialized = materializeGoldenRepo("dirty-tree");
  try {
    applyEdits(materialized.root, {
      ...task.oracle.solverEdits,
      "scratch/local-notes.md": "agent overwrote local notes\n",
    });
    const score = scoreOracle({
      task,
      materialized,
      observation: observation(),
    });
    expect(score.forbiddenTouched).toContain("scratch/local-notes.md");
    expect(score.acceptanceSuccess).toBe(false);
  } finally {
    rmSync(materialized.root, { recursive: true, force: true });
  }
});

test("each task kind has a solvable gold patch or an explicit BLOCKED research outcome", () => {
  const kinds = [
    "feature",
    "bug",
    "refactor",
    "spec",
    "security",
    "migration",
    "ui",
    "performance",
  ] as const;
  for (const kind of kinds) {
    const task = goldenTask(`golden/node-backend/${kind}`);
    const materialized = materializeGoldenRepo("node-backend");
    try {
      applyEdits(materialized.root, task.oracle.solverEdits);
      const score = scoreOracle({
        task,
        materialized,
        observation: observation(),
      });
      expect(score.acceptanceSuccess, task.taskId).toBe(true);
    } finally {
      rmSync(materialized.root, { recursive: true, force: true });
    }
  }
  const research = goldenTask("golden/node-backend/research");
  const materialized = materializeGoldenRepo("node-backend");
  try {
    const score = scoreOracle({
      task: research,
      materialized,
      observation: observation({ evidencePresent: ["investigation-report"] }),
    });
    expect(score.acceptanceSuccess).toBe(true);
  } finally {
    rmSync(materialized.root, { recursive: true, force: true });
  }
});
