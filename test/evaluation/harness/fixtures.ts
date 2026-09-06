import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FrozenEnvironment, TaskFixture } from "./types.js";

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadTask(name: string): TaskFixture {
  const raw = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, "fixtures", name), "utf8"),
  ) as TaskFixture;
  return Object.freeze({
    ...raw,
    sliceTags: Object.freeze([...raw.sliceTags]),
  });
}

export const FROZEN_ENVIRONMENT: FrozenEnvironment = Object.freeze({
  environmentId: "eval-host-fixture",
  deploymentId: "eval-fixture-deployment",
  piVersion: "0.84.3",
  temporalCutoff: "2026-08-01T00:00:00.000Z",
  verifierImage: "pi-hec-sealed-verifier-fixture",
  prngSeed: 20260829,
  outputLimitTokens: 8192,
  toolSchemaDigest: "sha256:eval-tool-schema-frozen",
  promptRevision: "production-protocol-v1",
});

export const IMMUTABLE_TASKS: readonly TaskFixture[] = Object.freeze([
  loadTask("polyglot.json"),
  loadTask("injection.json"),
  loadTask("undetermined.json"),
]);

export function taskById(taskId: string): TaskFixture {
  const task = IMMUTABLE_TASKS.find((item) => item.taskId === taskId);
  if (task === undefined) {
    throw new Error(`unknown evaluation task ${taskId}`);
  }
  return task;
}
