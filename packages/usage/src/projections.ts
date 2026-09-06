import type { StateStore, UsageEntryRecord } from "@pi-hec/state-store";

export type UsageScopeKind = "run" | "session" | "day" | "project";

export type UsageLedgerEntry = {
  usageEntryId: string;
  cloudCallId: string;
  runId: string;
  workspaceId: string;
  projectId: string;
  createdAt: string;
  correctionOf: string | undefined;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  normalizedTotalTokens: number | null;
  providerReported: boolean;
  complete: boolean;
  currency: string | null;
  estimatedCostDecimal: string | null;
  pricingSnapshotDigest: string | null;
};

export type CloudCallOutcome = {
  cloudCallId: string;
  runId: string;
  workspaceId: string;
  state: string;
  createdAt: string;
};

export type UsageProjection = {
  scope: UsageScopeKind;
  leafCount: number;
  incompleteCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  complete: boolean;
  estimatedCostDecimal: string | null;
  currency: string | null;
  acceptedCompletionCount: number;
};

export type UsageFilter = {
  entries: readonly UsageLedgerEntry[];
  calls: readonly CloudCallOutcome[];
  scope: UsageScopeKind;
  runId?: string;
  workspaceId?: string;
  day?: string;
  projectId?: string;
};

function optionalNumber(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

function fromRecord(record: UsageEntryRecord, projectId: string): UsageLedgerEntry {
  return {
    usageEntryId: record.usageEntryId,
    cloudCallId: record.cloudCallId,
    runId: record.runId,
    workspaceId: record.workspaceId,
    projectId,
    createdAt: record.createdAt,
    correctionOf: record.correctionOf,
    inputTokens: optionalNumber(record.inputTokens),
    outputTokens: optionalNumber(record.outputTokens),
    reasoningTokens: optionalNumber(record.reasoningTokens),
    cachedInputTokens: optionalNumber(record.cachedInputTokens),
    cacheWriteTokens: optionalNumber(record.cacheWriteTokens),
    normalizedTotalTokens: optionalNumber(record.normalizedTotalTokens),
    providerReported: record.providerReported,
    complete: record.complete,
    currency: record.currency ?? null,
    estimatedCostDecimal: record.estimatedCostDecimal ?? null,
    pricingSnapshotDigest: record.pricingSnapshotDigest ?? null,
  };
}

export function uniqueLeaves(entries: readonly UsageLedgerEntry[]): UsageLedgerEntry[] {
  const referenced = new Set(
    entries.flatMap((entry) => (entry.correctionOf === undefined ? [] : [entry.correctionOf])),
  );
  const leaves = entries.filter((entry) => !referenced.has(entry.usageEntryId));
  const latest = new Map<string, UsageLedgerEntry>();
  for (const leaf of leaves) {
    const current = latest.get(leaf.cloudCallId);
    if (current === undefined) {
      latest.set(leaf.cloudCallId, leaf);
      continue;
    }
    if (
      leaf.createdAt > current.createdAt ||
      (leaf.createdAt === current.createdAt && leaf.usageEntryId > current.usageEntryId)
    ) {
      latest.set(leaf.cloudCallId, leaf);
    }
  }
  return [...latest.values()].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -1 : 1;
    }
    return left.usageEntryId < right.usageEntryId ? -1 : 1;
  });
}

function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function inScope(
  entry: { runId: string; workspaceId: string; createdAt: string; projectId?: string },
  filter: UsageFilter,
): boolean {
  switch (filter.scope) {
    case "run":
      return filter.runId !== undefined && entry.runId === filter.runId;
    case "session":
      return filter.workspaceId !== undefined && entry.workspaceId === filter.workspaceId;
    case "day":
      return filter.day !== undefined && dayOf(entry.createdAt) === filter.day;
    case "project":
      return (
        filter.projectId === undefined ||
        !("projectId" in entry) ||
        entry.projectId === filter.projectId
      );
    default: {
      const exhaustive: never = filter.scope;
      return exhaustive;
    }
  }
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export function projectUsage(filter: UsageFilter): UsageProjection {
  const leaves = uniqueLeaves(filter.entries).filter((entry) => inScope(entry, filter));
  const calls = filter.calls.filter((call) =>
    inScope(
      {
        runId: call.runId,
        workspaceId: call.workspaceId,
        createdAt: call.createdAt,
        ...(filter.projectId === undefined ? {} : { projectId: filter.projectId }),
      },
      filter,
    ),
  );
  const acceptedCompletionCount = calls.filter((call) => call.state === "completed").length;
  const incompleteCount = leaves.filter((leaf) => !leaf.complete).length;
  const complete = leaves.length > 0 && incompleteCount === 0;
  const currencies = new Set(leaves.map((leaf) => leaf.currency));
  const costs = leaves.map((leaf) => leaf.estimatedCostDecimal);
  const sameCurrency = currencies.size === 1 && !currencies.has(null);
  const cost = sameCurrency && costs.every((value) => value !== null) ? sumDecimal(costs) : null;
  const currency = cost === null ? null : ([...currencies][0] ?? null);

  return {
    scope: filter.scope,
    leafCount: leaves.length,
    incompleteCount,
    inputTokens: sumOrNull(leaves.map((leaf) => leaf.inputTokens)),
    outputTokens: sumOrNull(leaves.map((leaf) => leaf.outputTokens)),
    reasoningTokens: sumOrNull(leaves.map((leaf) => leaf.reasoningTokens)),
    cachedInputTokens: sumOrNull(leaves.map((leaf) => leaf.cachedInputTokens)),
    cacheWriteTokens: sumOrNull(leaves.map((leaf) => leaf.cacheWriteTokens)),
    totalTokens: complete ? sumOrNull(leaves.map((leaf) => leaf.normalizedTotalTokens)) : null,
    complete,
    estimatedCostDecimal: cost,
    currency,
    acceptedCompletionCount,
  };
}

function sumDecimal(values: readonly (string | null)[]): string | null {
  if (values.some((value) => value === null)) {
    return null;
  }
  let scaled = 0n;
  let scale = 0;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    const frac = value.split(".")[1] ?? "";
    scale = Math.max(scale, frac.length);
  }
  for (const value of values) {
    if (value === null) {
      return null;
    }
    const [whole = "0", frac = ""] = value.split(".");
    const padded = frac.padEnd(scale, "0");
    scaled += BigInt(`${whole}${padded}`);
  }
  const text = scaled.toString().padStart(scale + 1, "0");
  if (scale === 0) {
    return text;
  }
  const split = text.length - scale;
  return `${text.slice(0, split)}.${text.slice(split)}`;
}

export function emptyUsageProjection(scope: UsageScopeKind): UsageProjection {
  return {
    scope,
    leafCount: 0,
    incompleteCount: 0,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    complete: false,
    estimatedCostDecimal: null,
    currency: null,
    acceptedCompletionCount: 0,
  };
}

function tokenLabel(value: number | null, complete: boolean): string {
  if (value === null || !complete) {
    return "incomplete";
  }
  return String(value);
}

export function formatUsageLines(input: {
  scope: UsageScopeKind;
  runId: string;
  state: string;
  projection: UsageProjection;
}): string[] {
  const tokensComplete = input.projection.complete;
  return [
    `HEC usage (${input.scope})`,
    `run: ${input.runId}`,
    `state: ${input.state}`,
    `input: ${tokenLabel(input.projection.inputTokens, tokensComplete)}`,
    `output: ${tokenLabel(input.projection.outputTokens, tokensComplete)}`,
    `reasoning: ${tokenLabel(input.projection.reasoningTokens, tokensComplete)}`,
    `total: ${tokenLabel(input.projection.totalTokens, tokensComplete)}`,
    `accepted completions: ${String(input.projection.acceptedCompletionCount)}`,
    "Totals are informational and do not affect routing.",
    "Open broker EXPORT for redacted usage artifacts.",
  ];
}

export function loadUsageLedger(
  store: Pick<StateStore, "listUsageEntries" | "listCloudCallOutcomes">,
  scope: Parameters<StateStore["appendUsage"]>[0],
): { entries: UsageLedgerEntry[]; calls: CloudCallOutcome[] } {
  const projectId = scope.projectId;
  return {
    entries: store.listUsageEntries(scope).map((record) => fromRecord(record, projectId)),
    calls: store.listCloudCallOutcomes(scope),
  };
}
