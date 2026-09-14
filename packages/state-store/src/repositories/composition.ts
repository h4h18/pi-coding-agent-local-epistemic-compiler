import type { ProjectScope } from "@pi-hec/domain";
import { executeWrite } from "../crash.js";
import { StoreLookupError } from "../errors.js";
import { optionalString, requiredInt, requiredString, rowOf } from "../rows.js";
import { scopedProjectId } from "../scope.js";
import { loadRunProjection } from "./runs.js";
import type {
  CompiledProfileRecord,
  PutCompiledProfileInput,
  PutRelatedRunInput,
  RelatedRunRecord,
  StoreRuntime,
} from "../types.js";

function requireRun(runtime: StoreRuntime, projectId: string, runId: string): void {
  if (loadRunProjection(runtime, projectId, runId) === undefined) {
    throw new StoreLookupError();
  }
}

function compiledFromRow(row: unknown): CompiledProfileRecord {
  const record = rowOf(row, "run_compiled_profiles");
  return {
    projectId: requiredString(record, "project_id"),
    runId: requiredString(record, "run_id"),
    profileJson: requiredString(record, "profile_json"),
    compositionJson: requiredString(record, "composition_json"),
    legacyProfileId: requiredString(record, "legacy_profile_id"),
    blockedReason: optionalString(record, "blocked_reason"),
    updatedAt: requiredString(record, "updated_at"),
  };
}

function relatedFromRow(row: unknown): RelatedRunRecord {
  const record = rowOf(row, "related_runs");
  return {
    projectId: requiredString(record, "project_id"),
    parentRunId: requiredString(record, "parent_run_id"),
    planId: requiredString(record, "plan_id"),
    childRunId: optionalString(record, "child_run_id"),
    relation: requiredString(record, "relation"),
    planJson: requiredString(record, "plan_json"),
    deferred: requiredInt(record, "deferred") === 1,
    blocksParent: requiredInt(record, "blocks_parent") === 1,
    status: requiredString(record, "status"),
    createdAt: requiredString(record, "created_at"),
  };
}

export function putCompiledProfile(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: PutCompiledProfileInput,
): CompiledProfileRecord {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, input.runId);
  return executeWrite(runtime, "putCompiledProfile", () => {
    runtime.db
      .prepare(
        `INSERT INTO run_compiled_profiles(
           project_id, run_id, profile_json, composition_json, legacy_profile_id,
           blocked_reason, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, run_id) DO UPDATE SET
           profile_json = excluded.profile_json,
           composition_json = excluded.composition_json,
           legacy_profile_id = excluded.legacy_profile_id,
           blocked_reason = excluded.blocked_reason,
           updated_at = excluded.updated_at`,
      )
      .run(
        projectId,
        input.runId,
        input.profileJson,
        input.compositionJson,
        input.legacyProfileId,
        input.blockedReason ?? null,
        input.updatedAt,
      );
    const row = runtime.db
      .prepare(
        `SELECT project_id, run_id, profile_json, composition_json, legacy_profile_id,
                blocked_reason, updated_at
         FROM run_compiled_profiles WHERE project_id = ? AND run_id = ?`,
      )
      .get(projectId, input.runId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    return compiledFromRow(row);
  });
}

export function getCompiledProfile(
  runtime: StoreRuntime,
  scope: ProjectScope,
  runId: string,
): CompiledProfileRecord | undefined {
  const projectId = scopedProjectId(scope);
  const row = runtime.db
    .prepare(
      `SELECT project_id, run_id, profile_json, composition_json, legacy_profile_id,
              blocked_reason, updated_at
       FROM run_compiled_profiles WHERE project_id = ? AND run_id = ?`,
    )
    .get(projectId, runId);
  if (row === undefined) {
    return undefined;
  }
  return compiledFromRow(row);
}

export function putRelatedRun(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: PutRelatedRunInput,
): RelatedRunRecord {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, input.parentRunId);
  return executeWrite(runtime, "putRelatedRun", () => {
    runtime.db
      .prepare(
        `INSERT INTO related_runs(
           project_id, parent_run_id, plan_id, child_run_id, relation, plan_json,
           deferred, blocks_parent, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, parent_run_id, plan_id) DO UPDATE SET
           child_run_id = excluded.child_run_id,
           relation = excluded.relation,
           plan_json = excluded.plan_json,
           deferred = excluded.deferred,
           blocks_parent = excluded.blocks_parent,
           status = excluded.status`,
      )
      .run(
        projectId,
        input.parentRunId,
        input.planId,
        input.childRunId ?? null,
        input.relation,
        input.planJson,
        input.deferred ? 1 : 0,
        input.blocksParent ? 1 : 0,
        input.status,
        input.createdAt,
      );
    const row = runtime.db
      .prepare(
        `SELECT project_id, parent_run_id, plan_id, child_run_id, relation, plan_json,
                deferred, blocks_parent, status, created_at
         FROM related_runs WHERE project_id = ? AND parent_run_id = ? AND plan_id = ?`,
      )
      .get(projectId, input.parentRunId, input.planId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    return relatedFromRow(row);
  });
}

export function listRelatedRuns(
  runtime: StoreRuntime,
  scope: ProjectScope,
  parentRunId: string,
): RelatedRunRecord[] {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, parentRunId);
  return runtime.db
    .prepare(
      `SELECT project_id, parent_run_id, plan_id, child_run_id, relation, plan_json,
              deferred, blocks_parent, status, created_at
       FROM related_runs WHERE project_id = ? AND parent_run_id = ?
       ORDER BY plan_id`,
    )
    .all(projectId, parentRunId)
    .map(relatedFromRow);
}

export function hasBlockingRelatedRuns(
  runtime: StoreRuntime,
  scope: ProjectScope,
  parentRunId: string,
): boolean {
  return listRelatedRuns(runtime, scope, parentRunId).some(
    (item) => item.blocksParent && !item.deferred && item.status !== "closed" && item.status !== "succeeded",
  );
}
