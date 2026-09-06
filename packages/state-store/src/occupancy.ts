import { TERMINAL_RUN_STATES, type ObjectDigest, type ProjectScope } from "@pi-hec/domain";
import { scopedProjectId } from "./scope.js";
import type { StoreRuntime } from "./types.js";

const TERMINAL_LIST = TERMINAL_RUN_STATES.map((state) => `'${state}'`).join(", ");

export function isGcForbidden(
  runtime: StoreRuntime,
  scope: ProjectScope,
  objectDigest: ObjectDigest,
): boolean {
  const projectId = scopedProjectId(scope);
  const row = runtime.db
    .prepare(
      `SELECT 1 AS occupied
       FROM runs r
       WHERE r.project_id = ?
         AND r.state NOT IN (${TERMINAL_LIST})
         AND (
           r.task_artifact_digest = ?
           OR r.requirement_ledger_digest = ?
           OR r.evidence_graph_digest = ?
           OR r.context_packet_digest = ?
           OR r.current_candidate_manifest_digest = ?
           OR r.verdict_report_digest = ?
           OR r.terminal_result_digest = ?
           OR EXISTS (
             SELECT 1 FROM run_artifacts ra
             WHERE ra.project_id = r.project_id AND ra.run_id = r.run_id AND ra.artifact_digest = ?
           )
           OR EXISTS (
             SELECT 1 FROM snapshots s
             JOIN snapshot_artifacts sa
               ON sa.project_id = s.project_id AND sa.snapshot_id = s.snapshot_id
             WHERE s.project_id = r.project_id
               AND s.workspace_id = r.workspace_id
               AND (
                 (r.snapshot_id IS NOT NULL AND s.snapshot_id = r.snapshot_id)
                 OR EXISTS (
                   SELECT 1 FROM run_artifacts ra
                   WHERE ra.project_id = r.project_id
                     AND ra.run_id = r.run_id
                     AND ra.role = 'snapshot-manifest'
                     AND ra.artifact_digest = s.manifest_digest
                 )
               )
               AND sa.artifact_digest = ?
           )
           OR EXISTS (
             SELECT 1 FROM snapshots s
             WHERE s.project_id = r.project_id
               AND s.workspace_id = r.workspace_id
               AND (
                 (r.snapshot_id IS NOT NULL AND s.snapshot_id = r.snapshot_id)
                 OR EXISTS (
                   SELECT 1 FROM run_artifacts ra
                   WHERE ra.project_id = r.project_id
                     AND ra.run_id = r.run_id
                     AND ra.role = 'snapshot-manifest'
                     AND ra.artifact_digest = s.manifest_digest
                 )
               )
               AND (s.root_digest = ? OR s.manifest_digest = ?)
           )
           OR EXISTS (
             SELECT 1 FROM run_events e
             WHERE e.project_id = r.project_id AND e.run_id = r.run_id AND e.payload_digest = ?
           )
           OR EXISTS (
             SELECT 1 FROM cloud_calls c
             JOIN usage_entries u
               ON u.project_id = c.project_id AND u.cloud_call_id = c.cloud_call_id
             WHERE c.project_id = r.project_id AND c.run_id = r.run_id AND u.pricing_snapshot_digest = ?
           )
           OR EXISTS (
             SELECT 1 FROM operations o
             WHERE o.project_id = r.project_id AND o.run_id = r.run_id
               AND (o.input_digest = ? OR o.result_digest = ? OR o.error_digest = ?)
           )
           OR EXISTS (
             SELECT 1 FROM operations o
             JOIN operation_artifacts oa
               ON oa.project_id = o.project_id AND oa.operation_id = o.operation_id
             WHERE o.project_id = r.project_id AND o.run_id = r.run_id AND oa.artifact_digest = ?
           )
           OR EXISTS (
             SELECT 1 FROM cloud_calls c
             WHERE c.project_id = r.project_id AND c.run_id = r.run_id
               AND (c.request_digest = ? OR c.context_packet_digest = ? OR c.response_digest = ?)
           )
           OR EXISTS (
             SELECT 1 FROM cloud_calls c
             JOIN cloud_call_artifacts ca
               ON ca.project_id = c.project_id AND ca.cloud_call_id = c.cloud_call_id
             WHERE c.project_id = r.project_id AND c.run_id = r.run_id AND ca.artifact_digest = ?
           )
         )
       LIMIT 1`,
    )
    .get(
      projectId,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
      objectDigest,
    );
  return row !== undefined;
}
