import { rmSync } from "node:fs";
import { expect, test } from "vitest";
import { RUN_STATES } from "@pi-hec/contracts";
import {
  GOLDEN_REPO_IDS,
  GOLDEN_TASKS,
  TASK_KINDS,
  classifiedRunStates,
  goldenTask,
  materializeGoldenRepo,
  promptLeaksOracle,
  workspaceOracleLeaks,
} from "./index.js";

test("catalog covers every golden repo and task kind without leaking oracles into prompts", () => {
  expect(GOLDEN_TASKS).toHaveLength(GOLDEN_REPO_IDS.length * TASK_KINDS.length);
  for (const repoId of GOLDEN_REPO_IDS) {
    for (const kind of TASK_KINDS) {
      const task = goldenTask(`golden/${repoId}/${kind}`);
      expect(task.repoId).toBe(repoId);
      expect(task.kind).toBe(kind);
      expect(promptLeaksOracle(task.prompt)).toBe(false);
      expect(task.oracle.mustNotChange.length).toBeGreaterThan(0);
      expect(JSON.stringify(task.oracle.solverEdits).includes("mustChange")).toBe(false);
    }
  }
});

test("every run state has an architectural disposition", () => {
  const classified = classifiedRunStates();
  expect(Object.keys(classified).sort()).toEqual([...RUN_STATES].sort());
});

test("materialized golden repos never contain hidden oracle tokens", () => {
  for (const repoId of GOLDEN_REPO_IDS) {
    const materialized = materializeGoldenRepo(repoId);
    try {
      expect(workspaceOracleLeaks(materialized.root)).toEqual([]);
      expect(materialized.baseline[materialized.paths.session]).toBeDefined();
      expect(materialized.baseline[materialized.paths.publicApi]).toBeDefined();
      expect(materialized.baseline[".pi/hec-adapter.yaml"]).toBeDefined();
      expect(materialized.baseline[".pi/extensions"]).toBeUndefined();
      if (repoId === "dirty-tree") {
        expect(materialized.baseline["scratch/local-notes.md"]).toBeDefined();
      }
      if (repoId === "no-tests") {
        expect(Object.keys(materialized.baseline).some((filePath) => filePath.includes(".test."))).toBe(
          false,
        );
      }
    } finally {
      rmSync(materialized.root, { recursive: true, force: true });
    }
  }
});
