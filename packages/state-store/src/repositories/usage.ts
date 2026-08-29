import type { ObjectDigest } from "@pi-hec/domain";
import type { ProjectScope } from "@pi-hec/domain";
import { executeWrite } from "../crash.js";
import { StoreLookupError } from "../errors.js";
import { optionalInt, optionalString, requiredInt, requiredString, rowOf } from "../rows.js";
import { scopedProjectId } from "../scope.js";
import type { CloudCallOutcomeRecord, StoreRuntime, UsageInput, UsageRecord } from "../types.js";

const USAGE_SELECT = `SELECT u.usage_entry_id AS usage_entry_id, u.cloud_call_id AS cloud_call_id,
          c.run_id AS run_id, r.workspace_id AS workspace_id, u.created_at AS created_at,
          u.correction_of AS correction_of, u.input_tokens AS input_tokens, u.output_tokens AS output_tokens,
          u.reasoning_tokens AS reasoning_tokens, u.cached_input_tokens AS cached_input_tokens,
          u.cache_write_tokens AS cache_write_tokens, u.normalized_total_tokens AS normalized_total_tokens,
          u.provider_reported AS provider_reported, u.complete AS complete, u.currency AS currency,
          u.estimated_cost_decimal AS estimated_cost_decimal,
          u.pricing_snapshot_digest AS pricing_snapshot_digest
   FROM usage_entries u
   JOIN cloud_calls c ON c.project_id = u.project_id AND c.cloud_call_id = u.cloud_call_id
   JOIN runs r ON r.project_id = c.project_id AND r.run_id = c.run_id`;

function usageFromRow(row: unknown): UsageRecord {
  const record = rowOf(row, "usage_entries");
  const pricing = optionalString(record, "pricing_snapshot_digest");
  return {
    usageEntryId: requiredString(record, "usage_entry_id"),
    cloudCallId: requiredString(record, "cloud_call_id"),
    runId: requiredString(record, "run_id"),
    workspaceId: requiredString(record, "workspace_id"),
    createdAt: requiredString(record, "created_at"),
    correctionOf: optionalString(record, "correction_of"),
    inputTokens: optionalInt(record, "input_tokens"),
    outputTokens: optionalInt(record, "output_tokens"),
    reasoningTokens: optionalInt(record, "reasoning_tokens"),
    cachedInputTokens: optionalInt(record, "cached_input_tokens"),
    cacheWriteTokens: optionalInt(record, "cache_write_tokens"),
    normalizedTotalTokens: optionalInt(record, "normalized_total_tokens"),
    providerReported: requiredInt(record, "provider_reported") === 1,
    complete: requiredInt(record, "complete") === 1,
    currency: optionalString(record, "currency"),
    estimatedCostDecimal: optionalString(record, "estimated_cost_decimal"),
    pricingSnapshotDigest: pricing === undefined ? undefined : (pricing as ObjectDigest),
  };
}

function tokenValue(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

export function appendUsage(runtime: StoreRuntime, scope: ProjectScope, input: UsageInput): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "appendUsage", () => {
    const call = runtime.db
      .prepare("SELECT 1 AS ok FROM cloud_calls WHERE project_id = ? AND cloud_call_id = ?")
      .get(projectId, input.cloudCallId);
    if (call === undefined) {
      throw new StoreLookupError();
    }
    runtime.db
      .prepare(
        `INSERT INTO usage_entries(
          project_id, usage_entry_id, cloud_call_id, input_tokens, output_tokens, reasoning_tokens,
          cached_input_tokens, cache_write_tokens, normalized_total_tokens, provider_reported,
          complete, currency, estimated_cost_decimal, pricing_snapshot_digest, correction_of, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        input.usageEntryId,
        input.cloudCallId,
        tokenValue(input.inputTokens),
        tokenValue(input.outputTokens),
        tokenValue(input.reasoningTokens),
        tokenValue(input.cachedInputTokens),
        tokenValue(input.cacheWriteTokens),
        tokenValue(input.normalizedTotalTokens),
        input.providerReported ? 1 : 0,
        input.complete ? 1 : 0,
        input.currency ?? null,
        input.estimatedCostDecimal ?? null,
        input.pricingSnapshotDigest ?? null,
        input.correctionOf ?? null,
        input.createdAt,
      );
  });
}

export function getUsage(runtime: StoreRuntime, scope: ProjectScope, usageEntryId: string): UsageRecord {
  const projectId = scopedProjectId(scope);
  const row = runtime.db
    .prepare(`${USAGE_SELECT} WHERE u.project_id = ? AND u.usage_entry_id = ?`)
    .get(projectId, usageEntryId);
  if (row === undefined) {
    throw new StoreLookupError();
  }
  return usageFromRow(row);
}

export function listUsageEntries(runtime: StoreRuntime, scope: ProjectScope): UsageRecord[] {
  const projectId = scopedProjectId(scope);
  const rows = runtime.db
    .prepare(`${USAGE_SELECT} WHERE u.project_id = ? ORDER BY u.created_at, u.usage_entry_id`)
    .all(projectId);
  return rows.map((row) => usageFromRow(row));
}

export function listCloudCallOutcomes(runtime: StoreRuntime, scope: ProjectScope): CloudCallOutcomeRecord[] {
  const projectId = scopedProjectId(scope);
  const rows = runtime.db
    .prepare(
      `SELECT c.cloud_call_id AS cloud_call_id, c.run_id AS run_id, r.workspace_id AS workspace_id,
              c.state AS state, c.created_at AS created_at
       FROM cloud_calls c
       JOIN runs r ON r.project_id = c.project_id AND r.run_id = c.run_id
       WHERE c.project_id = ?
       ORDER BY c.created_at, c.cloud_call_id`,
    )
    .all(projectId);
  return rows.map((row) => {
    const record = rowOf(row, "cloud_call_outcomes");
    return {
      cloudCallId: requiredString(record, "cloud_call_id"),
      runId: requiredString(record, "run_id"),
      workspaceId: requiredString(record, "workspace_id"),
      state: requiredString(record, "state"),
      createdAt: requiredString(record, "created_at"),
    };
  });
}
