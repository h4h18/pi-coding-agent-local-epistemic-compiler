import type { PrincipalScope, ProjectScope } from "@pi-hec/domain";
import { executeWrite } from "../crash.js";
import { hashSecretArgon2id, verifySecretArgon2id } from "../crypto.js";
import { StoreLookupError, StateVersionConflictError, UntrustedProjectError } from "../errors.js";
import { requiredInt, requiredString, rowOf } from "../rows.js";
import { requireProjectId, scopedProjectId } from "../scope.js";
import { insertArtifactRow } from "./artifacts.js";
import type {
  ApprovalRecord,
  ConsumeApprovalInput,
  ConsumeEnrollmentInput,
  CreateProjectInput,
  CreateRunnerInput,
  CreateWorkspaceInput,
  EnrollmentChallengeRecord,
  EnrollmentInput,
  GrantRunnerInput,
  InsertRunnerCertificateInput,
  OpenApprovalChallengeInput,
  ProjectRecord,
  RevokeRunnerGrantInput,
  RevokeRunnerInput,
  RunnerCertificateRecord,
  RunnerRecord,
  SetProjectTrustInput,
  StoreRuntime,
  UpdateProjectPolicyInput,
  WorkspaceRecord,
} from "../types.js";

function readProjectRow(runtime: StoreRuntime, projectId: string): ProjectRecord | undefined {
  const row = runtime.db
    .prepare(
      `SELECT project_id, display_name, trust_state, classification, policy_digest, state_version,
              created_at, updated_at
       FROM projects WHERE project_id = ?`,
    )
    .get(projectId);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "projects");
  const trustState = requiredString(record, "trust_state");
  if (trustState !== "untrusted" && trustState !== "trusted" && trustState !== "revoked") {
    throw new Error("invalid trust_state");
  }
  const classification = requiredString(record, "classification");
  if (
    classification !== "public" &&
    classification !== "internal" &&
    classification !== "confidential" &&
    classification !== "restricted"
  ) {
    throw new Error("invalid classification");
  }
  return {
    projectId: requiredString(record, "project_id"),
    displayName: requiredString(record, "display_name"),
    trustState,
    classification,
    policyDigest: requiredString(record, "policy_digest"),
    stateVersion: requiredInt(record, "state_version"),
    createdAt: requiredString(record, "created_at"),
    updatedAt: requiredString(record, "updated_at"),
  };
}

export function requireTrustedProject(runtime: StoreRuntime, projectId: string): ProjectRecord {
  const project = readProjectRow(runtime, projectId);
  if (project === undefined) {
    throw new StoreLookupError();
  }
  if (project.trustState !== "trusted") {
    throw new UntrustedProjectError();
  }
  return project;
}

export function createUntrustedProject(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  input: CreateProjectInput,
): void {
  requireProjectId(scope, input.projectId);
  executeWrite(
    runtime,
    "createUntrustedProject",
    () => {
      runtime.db
        .prepare(
          `INSERT INTO projects(
            project_id, display_name, trust_state, classification, policy_digest, state_version,
            created_at, updated_at
          ) VALUES (?, ?, 'untrusted', ?, ?, 0, ?, ?)`,
        )
        .run(
          input.projectId,
          input.displayName,
          input.classification,
          input.policy.digest,
          input.createdAt,
          input.createdAt,
        );
      insertArtifactRow(runtime, input.projectId, input.policy);
    },
    "deferred",
  );
}

export function setProjectTrust(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  input: SetProjectTrustInput,
): void {
  requireProjectId(scope, input.projectId);
  executeWrite(runtime, "setProjectTrust", () => {
    const project = readProjectRow(runtime, input.projectId);
    if (project === undefined) {
      throw new StoreLookupError();
    }
    runtime.db
      .prepare(
        `INSERT INTO approval_challenges(
          project_id, approval_id, run_id, action, principal_id, subject_digest, policy_digest,
          display_artifact_digest, challenge_digest, nonce_hash, expires_at, consumed_at, outcome,
          decision_digest, created_at
        ) VALUES (?, ?, NULL, 'project-trust', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.approvalId,
        input.principalId,
        input.subjectDigest,
        input.hostPolicyDigest,
        input.displayArtifactDigest,
        input.challengeDigest,
        input.nonceHash,
        input.expiresAt,
        input.consumedAt,
        input.outcome,
        input.decisionDigest,
        input.createdAt,
      );
    runtime.db
      .prepare(
        `INSERT INTO approvals(
          project_id, approval_id, run_id, action, principal_id, subject_digest, policy_digest,
          challenge_digest, decision_digest, grant_digest, expires_at, consumed_at, created_at
        ) VALUES (?, ?, NULL, 'project-trust', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.approvalId,
        input.principalId,
        input.subjectDigest,
        input.hostPolicyDigest,
        input.challengeDigest,
        input.decisionDigest,
        input.grantDigest,
        input.expiresAt,
        input.consumedAt,
        input.createdAt,
      );
    if (input.nextTrustState === "trusted") {
      if (input.outcome !== "approved") {
        throw new StoreLookupError();
      }
      runtime.db
        .prepare(
          `INSERT INTO project_policy_revisions(
            project_id, revision, policy_artifact_digest, approval_id, created_at
          ) VALUES (?, 1, ?, ?, ?)`,
        )
        .run(input.projectId, project.policyDigest, input.approvalId, input.createdAt);
      runtime.db
        .prepare(
          `UPDATE projects SET trust_state = 'trusted', state_version = state_version + 1, updated_at = ?
           WHERE project_id = ?`,
        )
        .run(input.createdAt, input.projectId);
      return;
    }
    runtime.db
      .prepare(
        `UPDATE projects SET trust_state = 'revoked', state_version = state_version + 1, updated_at = ?
         WHERE project_id = ?`,
      )
      .run(input.createdAt, input.projectId);
  });
}

export function getProject(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  projectId: string,
): ProjectRecord {
  requireProjectId(scope, projectId);
  const project = readProjectRow(runtime, projectId);
  if (project === undefined) {
    throw new StoreLookupError();
  }
  return project;
}

export function createRunner(
  runtime: StoreRuntime,
  _scope: PrincipalScope,
  input: CreateRunnerInput,
): void {
  executeWrite(runtime, "createRunner", () => {
    const existing = runtime.db
      .prepare("SELECT principal_id FROM runners WHERE runner_id = ?")
      .get(input.runnerId);
    if (existing !== undefined) {
      const record = rowOf(existing, "runners");
      if (requiredString(record, "principal_id") !== input.principalId) {
        throw new StoreLookupError();
      }
      return;
    }
    runtime.db
      .prepare(
        `INSERT INTO runners(runner_id, principal_id, platform, capability_digest, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.runnerId,
        input.principalId,
        input.platform,
        input.capabilityDigest,
        input.lastSeenAt,
      );
  });
}

export function grantRunnerProject(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: GrantRunnerInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "grantRunnerProject", () => {
    requireTrustedProject(runtime, projectId);
    runtime.db
      .prepare(
        `INSERT INTO runner_project_grants(project_id, runner_id, capability_policy_digest, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(projectId, input.runnerId, input.capabilityPolicyDigest, input.createdAt);
  });
}

export function revokeRunnerProjectGrant(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: RevokeRunnerGrantInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "revokeRunnerProjectGrant", () => {
    requireTrustedProject(runtime, projectId);
    const result = runtime.db
      .prepare(
        `UPDATE runner_project_grants
         SET revoked_at = ?
         WHERE project_id = ? AND runner_id = ? AND revoked_at IS NULL`,
      )
      .run(input.revokedAt, projectId, input.runnerId);
    if (result.changes !== 1) {
      throw new StoreLookupError();
    }
  });
}

export async function createEnrollmentChallenge(
  runtime: StoreRuntime,
  _scope: PrincipalScope,
  input: EnrollmentInput,
): Promise<void> {
  const verifier = await hashSecretArgon2id(input.secret, runtime.argon2);
  executeWrite(runtime, "createEnrollmentChallenge", () => {
    runtime.db
      .prepare(
        `INSERT INTO runner_enrollment_challenges(
          challenge_id, secret_verifier, permitted_projects_digest, expires_at, created_by_principal_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.challengeId,
        verifier,
        input.permittedProjectsDigest,
        input.expiresAt,
        input.createdByPrincipalId,
        input.createdAt,
      );
  });
}

export async function verifyEnrollmentSecret(
  runtime: StoreRuntime,
  challengeId: string,
  secret: Uint8Array,
): Promise<boolean> {
  const row = runtime.db
    .prepare("SELECT secret_verifier FROM runner_enrollment_challenges WHERE challenge_id = ?")
    .get(challengeId);
  if (row === undefined) {
    return false;
  }
  const verifier = requiredString(rowOf(row, "enrollment"), "secret_verifier");
  return verifySecretArgon2id(secret, verifier);
}

export function createWorkspace(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: CreateWorkspaceInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "createWorkspace", () => {
    requireTrustedProject(runtime, projectId);
    const grant = runtime.db
      .prepare(
        `SELECT 1 AS ok FROM runner_project_grants
         WHERE project_id = ? AND runner_id = ? AND revoked_at IS NULL`,
      )
      .get(projectId, input.runnerId);
    if (grant === undefined) {
      throw new StoreLookupError();
    }
    runtime.db
      .prepare(
        `INSERT INTO workspaces(
          workspace_id, project_id, runner_id, root_fingerprint, platform, broker_attestation_digest,
          registration_grant_digest, recovery_state, state_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'READY', 0, ?, ?)`,
      )
      .run(
        input.workspaceId,
        projectId,
        input.runnerId,
        input.rootFingerprint,
        input.platform,
        input.brokerAttestationDigest,
        input.registrationGrantDigest,
        input.createdAt,
        input.createdAt,
      );
  });
}

export function getApproval(
  runtime: StoreRuntime,
  scope: ProjectScope,
  approvalId: string,
): ApprovalRecord {
  const projectId = scopedProjectId(scope);
  const row = runtime.db
    .prepare(
      `SELECT approval_id, run_id, action, principal_id, grant_digest
       FROM approvals WHERE project_id = ? AND approval_id = ?`,
    )
    .get(projectId, approvalId);
  if (row === undefined) {
    throw new StoreLookupError();
  }
  const record = rowOf(row, "approvals");
  const runId = record.run_id;
  return {
    approvalId: requiredString(record, "approval_id"),
    runId: runId === null || runId === undefined ? undefined : requiredString(record, "run_id"),
    action: requiredString(record, "action"),
    principalId: requiredString(record, "principal_id"),
    grantDigest: requiredString(record, "grant_digest"),
  };
}

export function listProjects(runtime: StoreRuntime, scope: PrincipalScope): ProjectRecord[] {
  const rows = runtime.db
    .prepare(
      `SELECT project_id, display_name, trust_state, classification, policy_digest, state_version,
              created_at, updated_at
       FROM projects ORDER BY project_id`,
    )
    .all();
  const projects: ProjectRecord[] = [];
  for (const row of rows) {
    const record = rowOf(row, "projects");
    const projectId = requiredString(record, "project_id");
    if (
      scope.identityKind !== "admin" &&
      !scope.projectGrants.some((grant) => grant.projectId === projectId)
    ) {
      continue;
    }
    const read = readProjectRow(runtime, projectId);
    if (read !== undefined) {
      projects.push(read);
    }
  }
  return projects;
}

export function getWorkspace(
  runtime: StoreRuntime,
  scope: ProjectScope,
  workspaceId: string,
): WorkspaceRecord {
  const projectId = scopedProjectId(scope);
  const row = runtime.db
    .prepare(
      `SELECT workspace_id, project_id, runner_id, root_fingerprint, platform, registration_grant_digest,
              current_snapshot_id, recovery_state, state_version
       FROM workspaces WHERE project_id = ? AND workspace_id = ?`,
    )
    .get(projectId, workspaceId);
  if (row === undefined) {
    throw new StoreLookupError();
  }
  const record = rowOf(row, "workspaces");
  const recoveryState = requiredString(record, "recovery_state");
  if (
    recoveryState !== "READY" &&
    recoveryState !== "RECONCILING" &&
    recoveryState !== "MANUAL_RECOVERY_REQUIRED"
  ) {
    throw new Error("invalid recovery_state");
  }
  const currentSnapshotId = record.current_snapshot_id;
  return {
    projectId: requiredString(record, "project_id"),
    workspaceId: requiredString(record, "workspace_id"),
    runnerId: requiredString(record, "runner_id"),
    rootFingerprint: requiredString(record, "root_fingerprint"),
    platform: requiredString(record, "platform"),
    registrationGrantDigest: requiredString(record, "registration_grant_digest"),
    currentSnapshotId:
      currentSnapshotId === null || currentSnapshotId === undefined
        ? undefined
        : requiredString(record, "current_snapshot_id"),
    recoveryState,
    stateVersion: requiredInt(record, "state_version"),
  };
}

export function insertRunnerCertificate(
  runtime: StoreRuntime,
  _scope: PrincipalScope,
  input: InsertRunnerCertificateInput,
): void {
  executeWrite(runtime, "insertRunnerCertificate", () => {
    runtime.db
      .prepare(
        `UPDATE runner_certificates
         SET revoked_at = ?, revocation_reason = 'rotated'
         WHERE runner_id = ? AND certificate_serial <> ? AND revoked_at IS NULL`,
      )
      .run(input.issuedAt, input.runnerId, input.certificateSerial);
    runtime.db
      .prepare(
        `INSERT INTO runner_certificates(
          certificate_serial, runner_id, spki_sha256, not_before, not_after, issued_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.certificateSerial,
        input.runnerId,
        input.spkiSha256,
        input.notBefore,
        input.notAfter,
        input.issuedAt,
      );
  });
}

export function lookupRunnerCertificate(
  runtime: StoreRuntime,
  serial: string,
  spkiSha256: string,
): RunnerCertificateRecord | undefined {
  const row = runtime.db
    .prepare(
      `SELECT certificate_serial, runner_id, spki_sha256, not_before, not_after, issued_at, revoked_at
       FROM runner_certificates WHERE certificate_serial = ? AND spki_sha256 = ?`,
    )
    .get(serial, spkiSha256);
  return readCertificateRow(row);
}

export function lookupRunnerCertificateBySerial(
  runtime: StoreRuntime,
  serial: string,
): RunnerCertificateRecord | undefined {
  const row = runtime.db
    .prepare(
      `SELECT certificate_serial, runner_id, spki_sha256, not_before, not_after, issued_at, revoked_at
       FROM runner_certificates WHERE certificate_serial = ?`,
    )
    .get(serial);
  return readCertificateRow(row);
}

export function isRunnerCertificateRevoked(
  runtime: StoreRuntime,
  serial: string,
  spkiSha256: string,
): boolean {
  const record = lookupRunnerCertificate(runtime, serial, spkiSha256);
  return record !== undefined && record.revokedAt !== undefined;
}

function readCertificateRow(row: unknown): RunnerCertificateRecord | undefined {
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "runner_certificates");
  const revokedAt = record.revoked_at;
  return {
    certificateSerial: requiredString(record, "certificate_serial"),
    runnerId: requiredString(record, "runner_id"),
    spkiSha256: requiredString(record, "spki_sha256"),
    notBefore: requiredString(record, "not_before"),
    notAfter: requiredString(record, "not_after"),
    issuedAt: requiredString(record, "issued_at"),
    revokedAt:
      revokedAt === null || revokedAt === undefined
        ? undefined
        : requiredString(record, "revoked_at"),
  };
}

export function getRunner(runtime: StoreRuntime, runnerId: string): RunnerRecord | undefined {
  const row = runtime.db
    .prepare(
      "SELECT runner_id, principal_id, platform, revoked_at FROM runners WHERE runner_id = ?",
    )
    .get(runnerId);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "runners");
  const revokedAt = record.revoked_at;
  return {
    runnerId: requiredString(record, "runner_id"),
    principalId: requiredString(record, "principal_id"),
    platform: requiredString(record, "platform"),
    revokedAt:
      revokedAt === null || revokedAt === undefined
        ? undefined
        : requiredString(record, "revoked_at"),
  };
}

export function getRunnerByPrincipalId(
  runtime: StoreRuntime,
  principalId: string,
): RunnerRecord | undefined {
  const row = runtime.db
    .prepare(
      "SELECT runner_id, principal_id, platform, revoked_at FROM runners WHERE principal_id = ?",
    )
    .get(principalId);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "runners");
  const revokedAt = record.revoked_at;
  return {
    runnerId: requiredString(record, "runner_id"),
    principalId: requiredString(record, "principal_id"),
    platform: requiredString(record, "platform"),
    revokedAt:
      revokedAt === null || revokedAt === undefined
        ? undefined
        : requiredString(record, "revoked_at"),
  };
}

export function getRunnerPrincipalId(runtime: StoreRuntime, runnerId: string): string | undefined {
  const row = runtime.db
    .prepare("SELECT principal_id, revoked_at FROM runners WHERE runner_id = ?")
    .get(runnerId);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "runners");
  const revokedAt = record.revoked_at;
  if (revokedAt !== null && revokedAt !== undefined) {
    return undefined;
  }
  return requiredString(record, "principal_id");
}

export function listRunnerProjectGrants(
  runtime: StoreRuntime,
  runnerId: string,
): { projectId: string; grantDigest: string }[] {
  const rows = runtime.db
    .prepare(
      `SELECT project_id, capability_policy_digest
       FROM runner_project_grants WHERE runner_id = ? AND revoked_at IS NULL`,
    )
    .all(runnerId);
  return rows.map((row) => {
    const record = rowOf(row, "runner_project_grants");
    return {
      projectId: requiredString(record, "project_id"),
      grantDigest: requiredString(record, "capability_policy_digest"),
    };
  });
}

export function getEnrollmentChallenge(
  runtime: StoreRuntime,
  challengeId: string,
): EnrollmentChallengeRecord | undefined {
  const row = runtime.db
    .prepare(
      `SELECT challenge_id, permitted_projects_digest, expires_at, consumed_at, created_by_principal_id, created_at
       FROM runner_enrollment_challenges WHERE challenge_id = ?`,
    )
    .get(challengeId);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "enrollment");
  const consumedAt = record.consumed_at;
  return {
    challengeId: requiredString(record, "challenge_id"),
    permittedProjectsDigest: requiredString(record, "permitted_projects_digest"),
    expiresAt: requiredString(record, "expires_at"),
    consumedAt:
      consumedAt === null || consumedAt === undefined
        ? undefined
        : requiredString(record, "consumed_at"),
    createdByPrincipalId: requiredString(record, "created_by_principal_id"),
    createdAt: requiredString(record, "created_at"),
  };
}

export function consumeEnrollmentChallenge(
  runtime: StoreRuntime,
  input: ConsumeEnrollmentInput,
): void {
  executeWrite(runtime, "consumeEnrollmentChallenge", () => {
    const result = runtime.db
      .prepare(
        `UPDATE runner_enrollment_challenges
         SET consumed_at = ?
         WHERE challenge_id = ? AND consumed_at IS NULL`,
      )
      .run(input.consumedAt, input.challengeId);
    if (result.changes !== 1) {
      throw new StoreLookupError();
    }
  });
}

export function revokeRunner(
  runtime: StoreRuntime,
  _scope: PrincipalScope,
  input: RevokeRunnerInput,
): void {
  executeWrite(runtime, "revokeRunner", () => {
    const runner = runtime.db
      .prepare("SELECT principal_id FROM runners WHERE runner_id = ?")
      .get(input.runnerId);
    if (runner === undefined) {
      throw new StoreLookupError();
    }
    const owner = requiredString(rowOf(runner, "runners"), "principal_id");
    runtime.db
      .prepare("UPDATE runners SET revoked_at = ? WHERE runner_id = ? AND revoked_at IS NULL")
      .run(input.effectiveAt, input.runnerId);
    runtime.db
      .prepare(
        `UPDATE runner_certificates
         SET revoked_at = ?, revocation_reason = ?
         WHERE runner_id = ? AND revoked_at IS NULL`,
      )
      .run(input.effectiveAt, input.reason, input.runnerId);
    runtime.db
      .prepare(
        `UPDATE runner_project_grants SET revoked_at = ? WHERE runner_id = ? AND revoked_at IS NULL`,
      )
      .run(input.effectiveAt, input.runnerId);
    runtime.db
      .prepare(
        `UPDATE operations SET lease_until = ?
         WHERE lease_owner = ? AND state = 'leased'`,
      )
      .run(input.effectiveAt, owner);
  });
}

export function insertOpenApprovalChallenge(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: OpenApprovalChallengeInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "insertOpenApprovalChallenge", () => {
    runtime.db
      .prepare(
        `INSERT INTO approval_challenges(
          project_id, approval_id, run_id, action, principal_id, subject_digest, policy_digest,
          display_artifact_digest, challenge_digest, nonce_hash, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        input.approvalId,
        input.runId ?? null,
        input.action,
        input.principalId,
        input.subjectDigest,
        input.policyDigest,
        input.displayArtifactDigest,
        input.challengeDigest,
        input.nonceHash,
        input.expiresAt,
        input.createdAt,
      );
  });
}

export function consumeApprovalChallenge(
  runtime: StoreRuntime,
  scope: ProjectScope,
  input: ConsumeApprovalInput,
): void {
  const projectId = scopedProjectId(scope);
  executeWrite(runtime, "consumeApprovalChallenge", () => {
    const challenge = runtime.db
      .prepare(
        `SELECT approval_id, run_id, action, principal_id, subject_digest, policy_digest, challenge_digest
         FROM approval_challenges
         WHERE project_id = ? AND approval_id = ? AND consumed_at IS NULL`,
      )
      .get(projectId, input.approvalId);
    if (challenge === undefined) {
      throw new StoreLookupError();
    }
    const record = rowOf(challenge, "approval_challenges");
    runtime.db
      .prepare(
        `UPDATE approval_challenges
         SET consumed_at = ?, outcome = ?, decision_digest = ?
         WHERE project_id = ? AND approval_id = ? AND consumed_at IS NULL`,
      )
      .run(input.consumedAt, input.outcome, input.decisionDigest, projectId, input.approvalId);
    if (input.outcome === "approved") {
      runtime.db
        .prepare(
          `INSERT INTO approvals(
            project_id, approval_id, run_id, action, principal_id, subject_digest, policy_digest,
            challenge_digest, decision_digest, grant_digest, expires_at, consumed_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          input.approvalId,
          record.run_id === null || record.run_id === undefined
            ? null
            : requiredString(record, "run_id"),
          requiredString(record, "action"),
          requiredString(record, "principal_id"),
          requiredString(record, "subject_digest"),
          requiredString(record, "policy_digest"),
          requiredString(record, "challenge_digest"),
          input.decisionDigest,
          input.grantDigest,
          input.expiresAt,
          input.consumedAt,
          input.consumedAt,
        );
    }
  });
}

export function updateProjectPolicy(
  runtime: StoreRuntime,
  scope: PrincipalScope,
  input: UpdateProjectPolicyInput,
): ProjectRecord {
  requireProjectId(scope, input.projectId);
  return executeWrite(runtime, "updateProjectPolicy", () => {
    const current = readProjectRow(runtime, input.projectId);
    if (current === undefined) {
      throw new StoreLookupError();
    }
    if (current.stateVersion !== input.expectedStateVersion) {
      throw new StateVersionConflictError();
    }
    insertArtifactRow(runtime, input.projectId, input.policy);
    const nextVersion = current.stateVersion + 1;
    const updated = runtime.db
      .prepare(
        `UPDATE projects
         SET policy_digest = ?, state_version = ?, updated_at = ?
         WHERE project_id = ? AND state_version = ?`,
      )
      .run(
        input.policy.digest,
        nextVersion,
        input.createdAt,
        input.projectId,
        input.expectedStateVersion,
      );
    if (updated.changes !== 1) {
      throw new StateVersionConflictError();
    }
    runtime.db
      .prepare(
        `INSERT INTO project_policy_revisions(
          project_id, revision, policy_artifact_digest, approval_id, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.projectId, nextVersion, input.policy.digest, input.approvalId, input.createdAt);
    const next = readProjectRow(runtime, input.projectId);
    if (next === undefined) {
      throw new StoreLookupError();
    }
    return next;
  });
}
