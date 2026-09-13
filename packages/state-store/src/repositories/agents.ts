import type { ProjectScope } from "@pi-hec/domain";
import { executeWrite } from "../crash.js";
import { StoreLookupError } from "../errors.js";
import { optionalString, requiredInt, requiredString, rowOf } from "../rows.js";
import { scopedProjectId } from "../scope.js";
import { loadRunProjection } from "./runs.js";
import type {
  AgentHandleRecord,
  AgentNodeEventRecord,
  AgentNodeRecord,
  AppendAgentNodeEventInput,
  CapabilityTokenRecord,
  PutAgentHandleInput,
  PutCapabilityTokenInput,
  PutWorkspaceLeaseInput,
  StoreRuntime,
  UpsertAgentNodeInput,
  WorkspaceLeaseRecord,
} from "../types.js";

function requireRun(runtime: StoreRuntime, projectId: string, runId: string): void {
  if (loadRunProjection(runtime, projectId, runId) === undefined) {
    throw new StoreLookupError();
  }
}

function nodeFromRow(row: unknown): AgentNodeRecord {
  const record = rowOf(row, "agent_nodes");
  return {
    projectId: requiredString(record, "project_id"),
    runId: requiredString(record, "run_id"),
    nodeId: requiredString(record, "node_id"),
    attempt: requiredInt(record, "attempt"),
    status: requiredString(record, "status"),
    role: optionalString(record, "role"),
    operation: optionalString(record, "operation"),
    agentId: optionalString(record, "agent_id"),
    leaseId: optionalString(record, "lease_id"),
    artifactDigest: optionalString(record, "artifact_digest"),
    idempotencyKey: requiredString(record, "idempotency_key"),
    updatedAt: requiredString(record, "updated_at"),
  };
}

function handleFromRow(row: unknown): AgentHandleRecord {
  const record = rowOf(row, "agent_handles");
  return {
    projectId: requiredString(record, "project_id"),
    agentId: requiredString(record, "agent_id"),
    runId: requiredString(record, "run_id"),
    nodeId: requiredString(record, "node_id"),
    role: requiredString(record, "role"),
    sessionId: requiredString(record, "session_id"),
    adapter: requiredString(record, "adapter"),
    adapterVersion: requiredString(record, "adapter_version"),
    toolProfile: requiredString(record, "tool_profile"),
    capabilityTokenId: requiredString(record, "capability_token_id"),
    leaseId: optionalString(record, "lease_id"),
    spawnedAt: requiredString(record, "spawned_at"),
    lastHeartbeatAt: requiredString(record, "last_heartbeat_at"),
  };
}

function eventFromRow(row: unknown): AgentNodeEventRecord {
  const record = rowOf(row, "agent_node_events");
  return {
    projectId: requiredString(record, "project_id"),
    eventId: requiredString(record, "event_id"),
    runId: requiredString(record, "run_id"),
    nodeId: requiredString(record, "node_id"),
    sequence: requiredInt(record, "sequence"),
    eventType: requiredString(record, "event_type"),
    agentId: optionalString(record, "agent_id"),
    payloadDigest: requiredString(record, "payload_digest"),
    occurredAt: requiredString(record, "occurred_at"),
  };
}

function leaseFromRow(row: unknown): WorkspaceLeaseRecord {
  const record = rowOf(row, "workspace_leases");
  return {
    projectId: requiredString(record, "project_id"),
    leaseId: requiredString(record, "lease_id"),
    runId: requiredString(record, "run_id"),
    nodeId: requiredString(record, "node_id"),
    overlayPath: requiredString(record, "overlay_path"),
    branch: requiredString(record, "branch"),
    baseCommit: requiredString(record, "base_commit"),
    isolationVerified: requiredInt(record, "isolation_verified") === 1,
    createdAt: requiredString(record, "created_at"),
    expiresAt: requiredString(record, "expires_at"),
  };
}

function tokenFromRow(row: unknown): CapabilityTokenRecord {
  const record = rowOf(row, "capability_tokens");
  return {
    projectId: requiredString(record, "project_id"),
    tokenId: requiredString(record, "token_id"),
    runId: requiredString(record, "run_id"),
    nodeId: requiredString(record, "node_id"),
    agentId: requiredString(record, "agent_id"),
    role: requiredString(record, "role"),
    mac: requiredString(record, "mac"),
    issuedAt: requiredString(record, "issued_at"),
    expiresAt: requiredString(record, "expires_at"),
  };
}

export function upsertAgentNode(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: UpsertAgentNodeInput,
): AgentNodeRecord {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, input.runId);
  return executeWrite(runtime, "upsertAgentNode", () => {
    runtime.db
      .prepare(
        `INSERT INTO agent_nodes(
           project_id, run_id, node_id, attempt, status, role, operation, agent_id,
           lease_id, artifact_digest, idempotency_key, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, run_id, node_id) DO UPDATE SET
           attempt = excluded.attempt,
           status = excluded.status,
           role = excluded.role,
           operation = excluded.operation,
           agent_id = excluded.agent_id,
           lease_id = excluded.lease_id,
           artifact_digest = excluded.artifact_digest,
           idempotency_key = excluded.idempotency_key,
           updated_at = excluded.updated_at`,
      )
      .run(
        projectId,
        input.runId,
        input.nodeId,
        input.attempt,
        input.status,
        input.role ?? null,
        input.operation ?? null,
        input.agentId ?? null,
        input.leaseId ?? null,
        input.artifactDigest ?? null,
        input.idempotencyKey,
        input.updatedAt,
      );
    const row = runtime.db
      .prepare(
        `SELECT project_id, run_id, node_id, attempt, status, role, operation, agent_id,
                lease_id, artifact_digest, idempotency_key, updated_at
         FROM agent_nodes WHERE project_id = ? AND run_id = ? AND node_id = ?`,
      )
      .get(projectId, input.runId, input.nodeId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    return nodeFromRow(row);
  });
}

export function listAgentNodes(
  runtime: StoreRuntime,
  scope: ProjectScope,
  runId: string,
): AgentNodeRecord[] {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, runId);
  return runtime.db
    .prepare(
      `SELECT project_id, run_id, node_id, attempt, status, role, operation, agent_id,
              lease_id, artifact_digest, idempotency_key, updated_at
       FROM agent_nodes WHERE project_id = ? AND run_id = ?
       ORDER BY node_id`,
    )
    .all(projectId, runId)
    .map(nodeFromRow);
}

export type RetryingAgentRun = {
  projectId: string;
  runId: string;
};

export function listRetryingAgentRuns(runtime: StoreRuntime): RetryingAgentRun[] {
  return runtime.db
    .prepare(
      `SELECT DISTINCT project_id, run_id
       FROM agent_nodes
       WHERE status = 'RETRYING'
       ORDER BY project_id, run_id`,
    )
    .all()
    .map((row) => {
      const record = rowOf(row, "retrying-agent-run");
      return {
        projectId: requiredString(record, "project_id"),
        runId: requiredString(record, "run_id"),
      };
    });
}

export function putAgentHandle(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: PutAgentHandleInput,
): AgentHandleRecord {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, input.runId);
  return executeWrite(runtime, "putAgentHandle", () => {
    runtime.db
      .prepare(
        `INSERT INTO agent_handles(
           project_id, agent_id, run_id, node_id, role, session_id, adapter,
           adapter_version, tool_profile, capability_token_id, lease_id, spawned_at, last_heartbeat_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, agent_id) DO UPDATE SET
           last_heartbeat_at = excluded.last_heartbeat_at,
           session_id = excluded.session_id`,
      )
      .run(
        projectId,
        input.agentId,
        input.runId,
        input.nodeId,
        input.role,
        input.sessionId,
        input.adapter,
        input.adapterVersion,
        input.toolProfile,
        input.capabilityTokenId,
        input.leaseId ?? null,
        input.spawnedAt,
        input.lastHeartbeatAt,
      );
    const row = runtime.db
      .prepare(
        `SELECT project_id, agent_id, run_id, node_id, role, session_id, adapter,
                adapter_version, tool_profile, capability_token_id, lease_id, spawned_at, last_heartbeat_at
         FROM agent_handles WHERE project_id = ? AND agent_id = ?`,
      )
      .get(projectId, input.agentId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    return handleFromRow(row);
  });
}

export function listAgentHandles(
  runtime: StoreRuntime,
  scope: ProjectScope,
  runId: string,
): AgentHandleRecord[] {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, runId);
  return runtime.db
    .prepare(
      `SELECT project_id, agent_id, run_id, node_id, role, session_id, adapter,
              adapter_version, tool_profile, capability_token_id, lease_id, spawned_at, last_heartbeat_at
       FROM agent_handles WHERE project_id = ? AND run_id = ?
       ORDER BY spawned_at, agent_id`,
    )
    .all(projectId, runId)
    .map(handleFromRow);
}

export function appendAgentNodeEvent(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: AppendAgentNodeEventInput,
): AgentNodeEventRecord {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, input.runId);
  return executeWrite(runtime, "appendAgentNodeEvent", () => {
    runtime.db
      .prepare(
        `INSERT INTO agent_node_events(
           project_id, event_id, run_id, node_id, sequence, event_type, agent_id, payload_digest, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        input.eventId,
        input.runId,
        input.nodeId,
        input.sequence,
        input.eventType,
        input.agentId ?? null,
        input.payloadDigest,
        input.occurredAt,
      );
    return {
      projectId,
      eventId: input.eventId,
      runId: input.runId,
      nodeId: input.nodeId,
      sequence: input.sequence,
      eventType: input.eventType,
      agentId: input.agentId,
      payloadDigest: input.payloadDigest,
      occurredAt: input.occurredAt,
    };
  });
}

export function listAgentNodeEvents(
  runtime: StoreRuntime,
  scope: ProjectScope,
  runId: string,
): AgentNodeEventRecord[] {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, runId);
  return runtime.db
    .prepare(
      `SELECT project_id, event_id, run_id, node_id, sequence, event_type, agent_id, payload_digest, occurred_at
       FROM agent_node_events WHERE project_id = ? AND run_id = ?
       ORDER BY node_id, sequence`,
    )
    .all(projectId, runId)
    .map(eventFromRow);
}

export function putWorkspaceLease(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: PutWorkspaceLeaseInput,
): WorkspaceLeaseRecord {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, input.runId);
  return executeWrite(runtime, "putWorkspaceLease", () => {
    runtime.db
      .prepare(
        `INSERT INTO workspace_leases(
           project_id, lease_id, run_id, node_id, overlay_path, branch, base_commit,
           isolation_verified, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, lease_id) DO UPDATE SET
           isolation_verified = excluded.isolation_verified,
           expires_at = excluded.expires_at`,
      )
      .run(
        projectId,
        input.leaseId,
        input.runId,
        input.nodeId,
        input.overlayPath,
        input.branch,
        input.baseCommit,
        input.isolationVerified ? 1 : 0,
        input.createdAt,
        input.expiresAt,
      );
    const row = runtime.db
      .prepare(
        `SELECT project_id, lease_id, run_id, node_id, overlay_path, branch, base_commit,
                isolation_verified, created_at, expires_at
         FROM workspace_leases WHERE project_id = ? AND lease_id = ?`,
      )
      .get(projectId, input.leaseId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    return leaseFromRow(row);
  });
}

export function getWorkspaceLease(
  runtime: StoreRuntime,
  scope: ProjectScope,
  leaseId: string,
): WorkspaceLeaseRecord {
  const projectId = scopedProjectId(scope);
  const row = runtime.db
    .prepare(
      `SELECT project_id, lease_id, run_id, node_id, overlay_path, branch, base_commit,
              isolation_verified, created_at, expires_at
       FROM workspace_leases WHERE project_id = ? AND lease_id = ?`,
    )
    .get(projectId, leaseId);
  if (row === undefined) {
    throw new StoreLookupError();
  }
  return leaseFromRow(row);
}

export function listWorkspaceLeases(
  runtime: StoreRuntime,
  scope: ProjectScope,
  runId: string,
): WorkspaceLeaseRecord[] {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, runId);
  return runtime.db
    .prepare(
      `SELECT project_id, lease_id, run_id, node_id, overlay_path, branch, base_commit,
              isolation_verified, created_at, expires_at
       FROM workspace_leases WHERE project_id = ? AND run_id = ?
       ORDER BY created_at, lease_id`,
    )
    .all(projectId, runId)
    .map(leaseFromRow);
}

const LEASE_SELECT = `SELECT project_id, lease_id, run_id, node_id, overlay_path, branch, base_commit,
                isolation_verified, created_at, expires_at
         FROM workspace_leases`;

export function deleteWorkspaceLease(
  runtime: StoreRuntime,
  scope: ProjectScope,
  leaseId: string,
): boolean {
  const projectId = scopedProjectId(scope);
  return executeWrite(runtime, "deleteWorkspaceLease", () => {
    const result = runtime.db
      .prepare(`DELETE FROM workspace_leases WHERE project_id = ? AND lease_id = ?`)
      .run(projectId, leaseId);
    return result.changes > 0;
  });
}

export function scanWorkspaceLeases(runtime: StoreRuntime): WorkspaceLeaseRecord[] {
  return runtime.db.prepare(`${LEASE_SELECT} ORDER BY created_at, lease_id`).all().map(leaseFromRow);
}

export function listExpiredWorkspaceLeases(runtime: StoreRuntime, now: string): WorkspaceLeaseRecord[] {
  return runtime.db
    .prepare(`${LEASE_SELECT} WHERE expires_at < ? ORDER BY expires_at, lease_id`)
    .all(now)
    .map(leaseFromRow);
}

export function putCapabilityToken(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: PutCapabilityTokenInput,
): CapabilityTokenRecord {
  const projectId = scopedProjectId(scope);
  requireRun(runtime, projectId, input.runId);
  return executeWrite(runtime, "putCapabilityToken", () => {
    runtime.db
      .prepare(
        `INSERT INTO capability_tokens(
           project_id, token_id, run_id, node_id, agent_id, role, mac, issued_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, token_id) DO UPDATE SET
           mac = excluded.mac,
           expires_at = excluded.expires_at`,
      )
      .run(
        projectId,
        input.tokenId,
        input.runId,
        input.nodeId,
        input.agentId,
        input.role,
        input.mac,
        input.issuedAt,
        input.expiresAt,
      );
    const row = runtime.db
      .prepare(
        `SELECT project_id, token_id, run_id, node_id, agent_id, role, mac, issued_at, expires_at
         FROM capability_tokens WHERE project_id = ? AND token_id = ?`,
      )
      .get(projectId, input.tokenId);
    if (row === undefined) {
      throw new StoreLookupError();
    }
    return tokenFromRow(row);
  });
}

export function getCapabilityToken(
  runtime: StoreRuntime,
  scope: ProjectScope,
  tokenId: string,
): CapabilityTokenRecord {
  const projectId = scopedProjectId(scope);
  const row = runtime.db
    .prepare(
      `SELECT project_id, token_id, run_id, node_id, agent_id, role, mac, issued_at, expires_at
       FROM capability_tokens WHERE project_id = ? AND token_id = ?`,
    )
    .get(projectId, tokenId);
  if (row === undefined) {
    throw new StoreLookupError();
  }
  return tokenFromRow(row);
}
