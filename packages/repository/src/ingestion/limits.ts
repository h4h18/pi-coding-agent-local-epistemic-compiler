export const INDEX_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxUnitsPerFile: 500,
  maxTotalUnits: 200_000,
  maxOutputBytes: 64 * 1024 * 1024,
  parseBudgetMs: 2000,
  fallbackWindowBytes: 4096,
  fallbackOverlapBytes: 512,
  scipMaxBytes: 8 * 1024 * 1024,
} as const;

export class LimitError extends Error {
  readonly code = "LIMIT";

  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

export function assertWithinBudget(startedAt: number, label: string): void {
  if (Date.now() - startedAt > INDEX_LIMITS.parseBudgetMs) {
    throw new LimitError(`${label} exceeded CPU/time budget`);
  }
}
