import { FROZEN_ENVIRONMENT, IMMUTABLE_TASKS } from "./fixtures.js";
import type { FrozenEnvironment, SliceTag, TaskFixture } from "./types.js";

export const HOLDOUT_MIN_PAIRS = 1000;
export const HOLDOUT_MIN_PER_SLICE = 100;
export const REQUIRED_SLICES: readonly SliceTag[] = [
  "backend",
  "frontend",
  "mobile",
  "systems",
  "data",
  "infrastructure",
  "polyglot",
];

export function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

export function blockRandomizeOrder(taskIds: readonly string[], seed: number): string[] {
  const rng = createMulberry32(seed);
  const ordered = [...taskIds];
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const current = ordered[index];
    const other = ordered[swap];
    if (current === undefined || other === undefined) {
      continue;
    }
    ordered[index] = other;
    ordered[swap] = current;
  }
  return ordered;
}

export function freezeManifest(environment: FrozenEnvironment = FROZEN_ENVIRONMENT): {
  readonly taskIds: readonly string[];
  readonly repositoryCommits: Readonly<Record<string, string>>;
  readonly temporalCutoff: string;
  readonly deploymentId: string;
  readonly piVersion: "0.84.3";
  readonly promptRevision: string;
  readonly toolSchemaDigest: string;
  readonly outputLimitTokens: number;
  readonly verifierImage: string;
  readonly sliceWeights: Readonly<Record<string, number>>;
  readonly prngSeed: number;
  readonly holdoutNFrozen: number;
  readonly holdoutGatesClaimed: false;
} {
  const sliceWeights: Record<string, number> = {};
  for (const task of IMMUTABLE_TASKS) {
    sliceWeights[task.taskId] = task.weight;
  }
  const commits: Record<string, string> = {};
  for (const task of IMMUTABLE_TASKS) {
    commits[task.taskId] = task.repositoryCommit;
  }
  return {
    taskIds: IMMUTABLE_TASKS.map((task) => task.taskId),
    repositoryCommits: commits,
    temporalCutoff: environment.temporalCutoff,
    deploymentId: environment.deploymentId,
    piVersion: environment.piVersion,
    promptRevision: environment.promptRevision,
    toolSchemaDigest: environment.toolSchemaDigest,
    outputLimitTokens: environment.outputLimitTokens,
    verifierImage: environment.verifierImage,
    sliceWeights,
    prngSeed: environment.prngSeed,
    holdoutNFrozen: IMMUTABLE_TASKS.length,
    holdoutGatesClaimed: false,
  };
}

export function coverageStatus(tasks: readonly TaskFixture[]): {
  readonly pairCount: number;
  readonly underpowered: boolean;
  readonly underpoweredSlices: readonly SliceTag[];
  readonly holdoutGatesClaimed: false;
} {
  const pairCount = tasks.length;
  const underpoweredSlices = REQUIRED_SLICES.filter((slice) => {
    const count = tasks.filter((task) => task.sliceTags.includes(slice)).length;
    return count < HOLDOUT_MIN_PER_SLICE;
  });
  return {
    pairCount,
    underpowered: pairCount < HOLDOUT_MIN_PAIRS || underpoweredSlices.length > 0,
    underpoweredSlices,
    holdoutGatesClaimed: false,
  };
}

export function simulatePower(input: {
  readonly observedPairs: number;
  readonly targetPairs: number;
}): {
  readonly frozenN: number;
  readonly underpowered: boolean;
} {
  return {
    frozenN: input.observedPairs,
    underpowered: input.observedPairs < input.targetPairs,
  };
}
