import type { ProjectScope } from "@pi-hec/domain";
import { StoreLookupError } from "../errors.js";
import { requiredInt, requiredString, rowOf } from "../rows.js";
import { scopedProjectId } from "../scope.js";
import { loadRunProjection } from "./runs.js";
import type { StoredRunEvent, StoreRuntime } from "../types.js";

export function listRunEvents(
  runtime: StoreRuntime,
  scope: ProjectScope,
  runId: string,
): StoredRunEvent[] {
  const projectId = scopedProjectId(scope);
  if (loadRunProjection(runtime, projectId, runId) === undefined) {
    throw new StoreLookupError();
  }
  const rows = runtime.db
    .prepare(
      `SELECT event_id, run_id, sequence, event_type, actor_type, actor_id, payload_digest, occurred_at
       FROM run_events
       WHERE project_id = ? AND run_id = ?
       ORDER BY sequence ASC`,
    )
    .all(projectId, runId);
  return rows.map((row) => {
    const record = rowOf(row, "run_events");
    return {
      eventId: requiredString(record, "event_id"),
      runId: requiredString(record, "run_id"),
      sequence: requiredInt(record, "sequence"),
      eventType: requiredString(record, "event_type"),
      actorType: requiredString(record, "actor_type"),
      actorId: requiredString(record, "actor_id"),
      payloadDigest: requiredString(record, "payload_digest"),
      occurredAt: requiredString(record, "occurred_at"),
    };
  });
}
