import {
  ARTIFACT_ROLE_REGISTRY,
  artifactRolesSatisfyState,
  asObjectDigest,
  asRunId,
  createRunProjection,
  presentRolesOf,
  projectionArtifactRoles,
  reduceRun,
  RUN_STATES,
  type ObjectDigest,
  type ProjectScope,
  type RunProjection,
  type RunState,
  type VerifiedArtifactSet,
} from "@pi-hec/domain";
import { executeWrite } from "../crash.js";
import { CardinalityError, StateVersionConflictError, StoreLookupError } from "../errors.js";
import { optionalString, requiredInt, requiredString, rowOf } from "../rows.js";
import { scopedProjectId } from "../scope.js";
import { requireTrustedProject } from "./projects.js";
import { artifactExists } from "./artifacts.js";
import type { CreateRunInput, PersistRunEventInput, StoreRuntime } from "../types.js";

const RUN_STATE_SET: ReadonlySet<string> = new Set(RUN_STATES);

function asRunState(value: string): RunState {
  if (!RUN_STATE_SET.has(value)) {
    throw new Error(`unhandled union: ${JSON.stringify(value)}`);
  }
  return value as RunState;
}

function digestForRole(artifacts: VerifiedArtifactSet, role: string): string | null {
  const match = artifacts.bindings.find((binding) => binding.role === role);
  return match === undefined ? null : match.objectDigest;
}

function resolveSnapshotId(
  runtime: StoreRuntime,
  projectId: string,
  workspaceId: string,
  artifacts: VerifiedArtifactSet,
  inherited: string | undefined,
): string | null {
  const manifest = digestForRole(artifacts, "snapshot-manifest");
  if (manifest !== null) {
    const row = runtime.db
      .prepare(
        `SELECT snapshot_id FROM snapshots
         WHERE project_id = ? AND workspace_id = ? AND manifest_digest = ?`,
      )
      .get(projectId, workspaceId, manifest);
    if (row !== undefined) {
      return requiredString(rowOf(row, "snapshots"), "snapshot_id");
    }
  }
  return inherited ?? null;
}

function loadArtifactRoles(
  runtime: StoreRuntime,
  projectId: string,
  runId: string,
): RunProjection["artifactRoles"] {
  const rows = runtime.db
    .prepare(
      `SELECT role, artifact_digest FROM run_artifacts
       WHERE project_id = ? AND run_id = ?
       ORDER BY role, artifact_digest`,
    )
    .all(projectId, runId);
  const grouped = new Map<string, ObjectDigest[]>();
  for (const row of rows) {
    const record = rowOf(row, "run_artifacts");
    const role = requiredString(record, "role");
    const digest = asObjectDigest(requiredString(record, "artifact_digest"));
    const list = grouped.get(role) ?? [];
    list.push(digest);
    grouped.set(role, list);
  }
  return [...grouped.entries()].map(([role, objectDigests]) => {
    const registered = ARTIFACT_ROLE_REGISTRY.find((entry) => entry.role === role);
    if (registered === undefined) {
      throw new Error(`unknown artifact role ${role}`);
    }
    return { role, cardinality: registered.cardinality, objectDigests };
  });
}

export function loadRunProjection(
  runtime: StoreRuntime,
  projectId: string,
  runId: string,
): RunProjection | undefined {
  const row = runtime.db
    .prepare(
      `SELECT project_id, run_id, workspace_id, state, state_version, snapshot_id,
              terminal_result_digest, updated_at
       FROM runs WHERE project_id = ? AND run_id = ?`,
    )
    .get(projectId, runId);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "runs");
  const projection: RunProjection = {
    schemaVersion: 1,
    projectId: requiredString(record, "project_id"),
    runId: asRunId(requiredString(record, "run_id")),
    workspaceId: requiredString(record, "workspace_id"),
    state: asRunState(requiredString(record, "state")),
    stateVersion: requiredInt(record, "state_version"),
    artifactRoles: loadArtifactRoles(runtime, projectId, runId),
    updatedAt: requiredString(record, "updated_at"),
  };
  const snapshotId = optionalString(record, "snapshot_id");
  const terminal = optionalString(record, "terminal_result_digest");
  if (snapshotId !== undefined) {
    return {
      ...projection,
      snapshotId,
      ...(terminal === undefined ? {} : { terminalResultObjectDigest: asObjectDigest(terminal) }),
    };
  }
  if (terminal !== undefined) {
    return { ...projection, terminalResultObjectDigest: asObjectDigest(terminal) };
  }
  return projection;
}

export function createRun(runtime: StoreRuntime, scope: ProjectScope, input: CreateRunInput): RunProjection {
  const projectId = scopedProjectId(scope);
  return executeWrite(runtime, "createRun", () => {
    requireTrustedProject(runtime, projectId);
    if (!artifactExists(runtime, projectId, input.taskEnvelopeDigest)) {
      throw new StoreLookupError();
    }
    runtime.db
      .prepare(
        `INSERT INTO runs(
          project_id, run_id, workspace_id, state, state_version, task_artifact_digest, snapshot_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'CREATED', 0, ?, NULL, ?, ?)`,
      )
      .run(
        projectId,
        input.runId,
        input.workspaceId,
        input.taskEnvelopeDigest,
        input.createdAt,
        input.createdAt,
      );
    runtime.db
      .prepare(
        `INSERT INTO run_artifacts(project_id, run_id, role, artifact_digest, created_at)
         VALUES (?, ?, 'task-envelope', ?, ?)`,
      )
      .run(projectId, input.runId, input.taskEnvelopeDigest, input.createdAt);
    const created = createRunProjection({
      projectId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      occurredAt: input.createdAt,
      taskEnvelopeDigest: input.taskEnvelopeDigest,
    });
    return created;
  });
}

export function getRun(runtime: StoreRuntime, scope: ProjectScope, runId: string): RunProjection {
  const projectId = scopedProjectId(scope);
  const projection = loadRunProjection(runtime, projectId, runId);
  if (projection === undefined) {
    throw new StoreLookupError();
  }
  return projection;
}

function enforceCardinality(state: RunState, artifacts: VerifiedArtifactSet): void {
  if (!artifactRolesSatisfyState(presentRolesOf(artifacts), state)) {
    throw new CardinalityError(`required artifact roles missing for ${state}`);
  }
  const counts = new Map<string, number>();
  for (const binding of artifacts.bindings) {
    counts.set(binding.role, (counts.get(binding.role) ?? 0) + 1);
  }
  for (const [role, count] of counts) {
    const registered = ARTIFACT_ROLE_REGISTRY.find((entry) => entry.ownerKind === "run" && entry.role === role);
    if (registered === undefined) {
      throw new CardinalityError(`unknown artifact role ${role}`);
    }
    if (
      (registered.cardinality === "EXACTLY_ONE" || registered.cardinality === "ZERO_OR_ONE") &&
      count > 1
    ) {
      throw new CardinalityError(`singular role ${role} has ${String(count)} bindings`);
    }
  }
}

function replaceRunArtifacts(
  runtime: StoreRuntime,
  projectId: string,
  runId: string,
  artifacts: VerifiedArtifactSet,
  createdAt: string,
): void {
  runtime.db
    .prepare("DELETE FROM run_artifacts WHERE project_id = ? AND run_id = ?")
    .run(projectId, runId);
  const insert = runtime.db.prepare(
    `INSERT INTO run_artifacts(project_id, run_id, role, artifact_digest, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const binding of artifacts.bindings) {
    insert.run(projectId, runId, binding.role, binding.objectDigest, createdAt);
  }
}

export function persistRunEvent(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: PersistRunEventInput,
): RunProjection {
  const projectId = scopedProjectId(scope);
  if (input.event.projectId !== projectId) {
    throw new StoreLookupError();
  }
  return executeWrite(runtime, "persistRunEvent", () => {
    const current = loadRunProjection(runtime, projectId, input.event.runId);
    if (current === undefined) {
      throw new StoreLookupError();
    }
    if (current.stateVersion !== input.event.expectedStateVersion) {
      throw new StateVersionConflictError();
    }
    if (!artifactExists(runtime, projectId, input.payloadDigest)) {
      throw new StoreLookupError();
    }
    const reduced = reduceRun(current, input.event, input.artifacts);
    enforceCardinality(reduced.projection.state, input.artifacts);
    const next = reduced.projection;
    next.artifactRoles = projectionArtifactRoles(input.artifacts);
    const terminal =
      next.state === "SUCCEEDED" ? (next.terminalResultObjectDigest ?? digestForRole(input.artifacts, "successful-run-result")) : null;
    if (next.state === "SUCCEEDED" && terminal === null) {
      throw new CardinalityError("SUCCEEDED requires terminal_result_digest");
    }
    const cas = runtime.db
      .prepare(
        `UPDATE runs SET
           state = ?,
           state_version = ?,
           task_artifact_digest = ?,
           snapshot_id = ?,
           requirement_ledger_digest = ?,
           evidence_graph_digest = ?,
           context_packet_digest = ?,
           current_candidate_manifest_digest = ?,
           verdict_report_digest = ?,
           terminal_result_digest = ?,
           updated_at = ?
         WHERE project_id = ? AND run_id = ? AND state_version = ?`,
      )
      .run(
        next.state,
        next.stateVersion,
        digestForRole(input.artifacts, "task-envelope"),
        resolveSnapshotId(
          runtime,
          projectId,
          next.workspaceId,
          input.artifacts,
          next.snapshotId ?? current.snapshotId,
        ),
        digestForRole(input.artifacts, "requirement-ledger"),
        digestForRole(input.artifacts, "evidence-graph"),
        digestForRole(input.artifacts, "context-packet"),
        digestForRole(input.artifacts, "candidate-manifest"),
        digestForRole(input.artifacts, "verdict-report"),
        terminal,
        next.updatedAt,
        projectId,
        input.event.runId,
        input.event.expectedStateVersion,
      );
    if (cas.changes !== 1) {
      throw new StateVersionConflictError();
    }
    runtime.db
      .prepare(
        `INSERT INTO run_events(
          project_id, event_id, run_id, sequence, event_type, actor_type, actor_id, causation_id,
          correlation_id, payload_digest, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        input.event.eventId,
        input.event.runId,
        next.stateVersion,
        input.event.eventType,
        input.event.actorType,
        input.event.actorId,
        input.event.causationId ?? null,
        input.event.correlationId ?? null,
        input.payloadDigest,
        input.event.occurredAt,
      );
    replaceRunArtifacts(runtime, projectId, input.event.runId, input.artifacts, input.event.occurredAt);
    const stored = loadRunProjection(runtime, projectId, input.event.runId);
    if (stored === undefined) {
      throw new StateVersionConflictError();
    }
    return stored;
  });
}
