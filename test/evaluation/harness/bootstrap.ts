import { meanAndP95FromLedger, type WeightedCompletion } from "./ledger.js";
import { createMulberry32 } from "./protocol.js";

export type PairedCompletion = WeightedCompletion & {
  readonly baselineCompletions: number;
  readonly hecCompletions: number;
};

export type BootstrapInterval = {
  readonly lower: number;
  readonly upper: number;
  readonly draws: number;
  readonly seed: number;
};

function resamplePairs(rows: readonly PairedCompletion[], rng: () => number): PairedCompletion[] {
  const byRepo = new Map<string, PairedCompletion[]>();
  for (const row of rows) {
    const bucket = byRepo.get(row.repositoryId) ?? [];
    bucket.push(row);
    byRepo.set(row.repositoryId, bucket);
  }
  const sample: PairedCompletion[] = [];
  for (const cluster of byRepo.values()) {
    for (let index = 0; index < cluster.length; index += 1) {
      const pick = cluster[Math.floor(rng() * cluster.length)];
      if (pick === undefined) {
        continue;
      }
      sample.push(pick);
    }
  }
  return sample;
}

function asWeighted(rows: readonly PairedCompletion[], valueOf: (row: PairedCompletion) => number): WeightedCompletion[] {
  return rows.map((row) => ({
    taskId: row.taskId,
    repositoryId: row.repositoryId,
    weight: row.weight,
    completions: valueOf(row),
  }));
}

export function pairedBootstrap(
  rows: readonly PairedCompletion[],
  seed: number,
  draws: number,
): { readonly meanDelta: BootstrapInterval; readonly p95Delta: BootstrapInterval } {
  const rng = createMulberry32(seed);
  const meanSamples: number[] = [];
  const p95Samples: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    const sample = resamplePairs(rows, rng);
    const hecStats = meanAndP95FromLedger(asWeighted(sample, (row) => row.hecCompletions));
    const baselineStats = meanAndP95FromLedger(asWeighted(sample, (row) => row.baselineCompletions));
    meanSamples.push(hecStats.mean - baselineStats.mean);
    p95Samples.push(hecStats.p95 - baselineStats.p95);
  }
  meanSamples.sort((left, right) => left - right);
  p95Samples.sort((left, right) => left - right);
  const lowerIndex = Math.floor(0.025 * draws);
  const upperIndex = Math.min(draws - 1, Math.ceil(0.975 * draws) - 1);
  return {
    meanDelta: {
      lower: meanSamples[lowerIndex] ?? 0,
      upper: meanSamples[upperIndex] ?? 0,
      draws,
      seed,
    },
    p95Delta: {
      lower: p95Samples[lowerIndex] ?? 0,
      upper: p95Samples[upperIndex] ?? 0,
      draws,
      seed,
    },
  };
}
