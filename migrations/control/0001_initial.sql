CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE host_authority_artifacts (
  object_digest TEXT PRIMARY KEY,
  schema_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  encryption_key_id TEXT NOT NULL,
  encryption_nonce TEXT NOT NULL,
  signature_key_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(encryption_key_id, encryption_nonce)
) STRICT;

CREATE TABLE run_state_registry (
  state TEXT PRIMARY KEY
) STRICT, WITHOUT ROWID;

CREATE TABLE operation_kind_registry (
  operation_kind TEXT PRIMARY KEY,
  reclaimable INTEGER NOT NULL CHECK (reclaimable IN (0,1)),
  UNIQUE(operation_kind, reclaimable)
) STRICT, WITHOUT ROWID;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  trust_state TEXT NOT NULL CHECK (trust_state IN ('untrusted','trusted','revoked')),
  classification TEXT NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  policy_digest TEXT NOT NULL,
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id, policy_digest)
    REFERENCES artifacts(project_id, digest)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE workspaces (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  runner_id TEXT NOT NULL,
  root_fingerprint TEXT NOT NULL,
  platform TEXT NOT NULL,
  broker_attestation_digest TEXT NOT NULL,
  registration_grant_digest TEXT NOT NULL,
  current_snapshot_id TEXT,
  recovery_state TEXT NOT NULL CHECK (recovery_state IN ('READY','RECONCILING','MANUAL_RECOVERY_REQUIRED')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, workspace_id),
  UNIQUE(project_id, workspace_id, runner_id),
  UNIQUE(project_id, runner_id, root_fingerprint),
  FOREIGN KEY(project_id, runner_id)
    REFERENCES runner_project_grants(project_id, runner_id),
  FOREIGN KEY(project_id, broker_attestation_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, registration_grant_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, workspace_id, current_snapshot_id)
    REFERENCES snapshots(project_id, workspace_id, snapshot_id)
) STRICT;

CREATE TABLE runs (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  task_artifact_digest TEXT NOT NULL,
  snapshot_id TEXT,
  requirement_ledger_digest TEXT,
  evidence_graph_digest TEXT,
  context_packet_digest TEXT,
  current_candidate_manifest_digest TEXT,
  verdict_report_digest TEXT,
  terminal_result_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, run_id),
  FOREIGN KEY(project_id, workspace_id)
    REFERENCES workspaces(project_id, workspace_id),
  FOREIGN KEY(project_id, workspace_id, snapshot_id)
    REFERENCES snapshots(project_id, workspace_id, snapshot_id),
  FOREIGN KEY(project_id, task_artifact_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, requirement_ledger_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, evidence_graph_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, context_packet_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, current_candidate_manifest_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, verdict_report_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, terminal_result_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(state)
    REFERENCES run_state_registry(state),
  CHECK (
    (state = 'SUCCEEDED' AND terminal_result_digest IS NOT NULL)
    OR
    (state <> 'SUCCEEDED' AND terminal_result_digest IS NULL)
  )
) STRICT;

CREATE TABLE run_events (
  project_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  payload_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY(project_id, event_id),
  UNIQUE(project_id, run_id, sequence),
  FOREIGN KEY(project_id, run_id)
    REFERENCES runs(project_id, run_id),
  FOREIGN KEY(project_id, payload_digest)
    REFERENCES artifacts(project_id, digest)
) STRICT;

CREATE TABLE api_idempotency_requests (
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  method TEXT NOT NULL,
  target_uri TEXT NOT NULL,
  semantic_request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','completed','failed','reconcile-required')),
  response_status INTEGER,
  response_headers_ciphertext BLOB,
  response_body_ciphertext BLOB,
  response_encryption_key_id TEXT,
  response_encryption_nonce TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(principal_id, operation_id),
  UNIQUE(principal_id, scope_key, method, target_uri, semantic_request_digest),
  UNIQUE(response_encryption_key_id, response_encryption_nonce),
  CHECK (
    (state = 'reserved'
      AND response_status IS NULL
      AND response_headers_ciphertext IS NULL
      AND response_body_ciphertext IS NULL
      AND response_encryption_key_id IS NULL
      AND response_encryption_nonce IS NULL)
    OR
    (state IN ('completed','failed')
      AND response_status BETWEEN 100 AND 599
      AND response_headers_ciphertext IS NOT NULL
      AND response_encryption_key_id IS NOT NULL
      AND response_encryption_nonce IS NOT NULL)
    OR
    (state = 'reconcile-required'
      AND response_status IS NULL
      AND response_headers_ciphertext IS NULL
      AND response_body_ciphertext IS NULL
      AND response_encryption_key_id IS NULL
      AND response_encryption_nonce IS NULL)
  )
) STRICT;

CREATE TABLE operations (
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','leased','succeeded','failed','cancelled','unknown')),
  reclaimable INTEGER NOT NULL CHECK (reclaimable IN (0,1)),
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_owner TEXT,
  lease_until TEXT,
  lease_token_hash TEXT,
  result_digest TEXT,
  error_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, operation_id),
  UNIQUE(project_id, run_id, dedupe_key),
  FOREIGN KEY(project_id, run_id)
    REFERENCES runs(project_id, run_id),
  FOREIGN KEY(project_id, input_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, result_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, error_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(operation_kind, reclaimable)
    REFERENCES operation_kind_registry(operation_kind, reclaimable),
  CHECK (
    (state = 'ready'
      AND lease_owner IS NULL AND lease_until IS NULL AND lease_token_hash IS NULL
      AND result_digest IS NULL AND error_digest IS NULL)
    OR
    (state = 'leased'
      AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND lease_token_hash IS NOT NULL
      AND result_digest IS NULL AND error_digest IS NULL)
    OR
    (state = 'succeeded'
      AND lease_owner IS NULL AND lease_until IS NULL AND lease_token_hash IS NULL
      AND result_digest IS NOT NULL AND error_digest IS NULL)
    OR
    (state IN ('failed','unknown')
      AND lease_owner IS NULL AND lease_until IS NULL AND lease_token_hash IS NULL
      AND result_digest IS NULL AND error_digest IS NOT NULL)
    OR
    (state = 'cancelled'
      AND lease_owner IS NULL AND lease_until IS NULL AND lease_token_hash IS NULL
      AND result_digest IS NULL AND error_digest IS NULL)
  )
) STRICT;

CREATE TABLE artifacts (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  digest TEXT NOT NULL,
  schema_name TEXT,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  classification TEXT NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm IN ('AES-256-GCM','XCHACHA20-POLY1305')),
  encryption_key_id TEXT NOT NULL,
  encryption_nonce TEXT NOT NULL,
  storage_record_digest TEXT NOT NULL,
  storage_record_signing_key_id TEXT NOT NULL,
  storage_record_signature_algorithm TEXT NOT NULL
    CHECK (storage_record_signature_algorithm IN ('Ed25519','ECDSA-P256-SHA256')),
  storage_record_signed_at TEXT NOT NULL,
  storage_record_signer_certificate_digest TEXT NOT NULL,
  storage_record_signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, digest),
  UNIQUE(encryption_key_id, encryption_nonce),
  FOREIGN KEY(storage_record_signer_certificate_digest)
    REFERENCES host_authority_artifacts(object_digest)
) STRICT;

CREATE TABLE artifact_role_registry (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('run','snapshot','operation','cloud-call')),
  role TEXT NOT NULL,
  cardinality TEXT NOT NULL CHECK (cardinality IN ('EXACTLY_ONE','ZERO_OR_ONE','ONE_OR_MORE')),
  artifact_schema_name TEXT,
  PRIMARY KEY(owner_kind, role)
) STRICT, WITHOUT ROWID;

CREATE TABLE run_artifacts (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, run_id, role, artifact_digest),
  FOREIGN KEY(project_id, run_id)
    REFERENCES runs(project_id, run_id),
  FOREIGN KEY(project_id, artifact_digest)
    REFERENCES artifacts(project_id, digest)
) STRICT;

CREATE TABLE snapshots (
  project_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, snapshot_id),
  UNIQUE(project_id, workspace_id, snapshot_id),
  UNIQUE(project_id, workspace_id, root_digest),
  FOREIGN KEY(project_id, workspace_id)
    REFERENCES workspaces(project_id, workspace_id),
  FOREIGN KEY(project_id, workspace_id, runner_id)
    REFERENCES workspaces(project_id, workspace_id, runner_id),
  FOREIGN KEY(project_id, manifest_digest)
    REFERENCES artifacts(project_id, digest)
) STRICT;

CREATE TABLE snapshot_artifacts (
  project_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  role TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, snapshot_id, role, artifact_digest),
  FOREIGN KEY(project_id, snapshot_id)
    REFERENCES snapshots(project_id, snapshot_id),
  FOREIGN KEY(project_id, artifact_digest)
    REFERENCES artifacts(project_id, digest)
) STRICT;

CREATE TABLE cloud_calls (
  project_id TEXT NOT NULL,
  cloud_call_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('initial','context-followup','repair')),
  deployment_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  context_packet_digest TEXT NOT NULL,
  recovery_grade TEXT NOT NULL CHECK (recovery_grade IN ('A','B','C')),
  state TEXT NOT NULL CHECK (state IN ('prepared','dispatching','in-flight','completed','failed','outcome-unknown','cancelled')),
  provider_request_id TEXT,
  provider_operation_id TEXT,
  response_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, cloud_call_id),
  UNIQUE(project_id, run_id, purpose, request_digest),
  FOREIGN KEY(project_id, run_id)
    REFERENCES runs(project_id, run_id),
  FOREIGN KEY(project_id, request_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, context_packet_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, response_digest)
    REFERENCES artifacts(project_id, digest),
  CHECK (
    (state = 'completed' AND response_digest IS NOT NULL)
    OR
    (state <> 'completed' AND response_digest IS NULL)
  )
) STRICT;

CREATE TABLE cloud_transport_attempts (
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  cloud_call_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  request_started_at TEXT NOT NULL,
  response_started_at TEXT,
  completed_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'not-dispatched',
    'failed-before-acceptance',
    'accepted',
    'completed',
    'accepted-outcome-unknown',
    'reconciled'
  )),
  provider_request_id TEXT,
  PRIMARY KEY(project_id, attempt_id),
  UNIQUE(project_id, cloud_call_id, attempt_number),
  FOREIGN KEY(project_id, cloud_call_id)
    REFERENCES cloud_calls(project_id, cloud_call_id)
) STRICT;

CREATE TABLE usage_entries (
  project_id TEXT NOT NULL,
  usage_entry_id TEXT NOT NULL,
  cloud_call_id TEXT NOT NULL,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  normalized_total_tokens INTEGER CHECK (normalized_total_tokens IS NULL OR normalized_total_tokens >= 0),
  provider_reported INTEGER NOT NULL CHECK (provider_reported IN (0,1)),
  complete INTEGER NOT NULL CHECK (complete IN (0,1)),
  currency TEXT,
  estimated_cost_decimal TEXT,
  pricing_snapshot_digest TEXT,
  correction_of TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, usage_entry_id),
  UNIQUE(project_id, usage_entry_id, cloud_call_id),
  UNIQUE(project_id, correction_of),
  FOREIGN KEY(project_id, cloud_call_id)
    REFERENCES cloud_calls(project_id, cloud_call_id),
  FOREIGN KEY(project_id, correction_of, cloud_call_id)
    REFERENCES usage_entries(project_id, usage_entry_id, cloud_call_id),
  FOREIGN KEY(project_id, pricing_snapshot_digest)
    REFERENCES artifacts(project_id, digest),
  CHECK (
    normalized_total_tokens IS NULL
    OR normalized_total_tokens =
      COALESCE(input_tokens, 0) +
      COALESCE(output_tokens, 0) +
      COALESCE(reasoning_tokens, 0)
  ),
  CHECK (complete = 0 OR normalized_total_tokens IS NOT NULL),
  CHECK (cached_input_tokens IS NULL OR input_tokens IS NULL OR cached_input_tokens <= input_tokens),
  CHECK (
    (currency IS NULL AND estimated_cost_decimal IS NULL AND pricing_snapshot_digest IS NULL)
    OR
    (currency IS NOT NULL AND estimated_cost_decimal IS NOT NULL AND pricing_snapshot_digest IS NOT NULL)
  ),
  CHECK (correction_of IS NULL OR correction_of <> usage_entry_id)
) STRICT;

CREATE TABLE approvals (
  project_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  run_id TEXT,
  action TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  challenge_digest TEXT NOT NULL,
  decision_digest TEXT NOT NULL,
  grant_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, approval_id),
  UNIQUE(project_id, decision_digest),
  UNIQUE(project_id, grant_digest),
  CHECK (
    (run_id IS NULL AND action IN ('project-trust','project-policy','workspace-registration'))
    OR
    (run_id IS NOT NULL AND action IN ('cloud-egress','command','workspace-promotion'))
  ),
  FOREIGN KEY(project_id, run_id)
    REFERENCES runs(project_id, run_id),
  FOREIGN KEY(project_id, subject_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(policy_digest)
    REFERENCES host_authority_artifacts(object_digest),
  FOREIGN KEY(project_id, challenge_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, decision_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, grant_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, approval_id, challenge_digest)
    REFERENCES approval_challenges(project_id, approval_id, challenge_digest)
) STRICT;

CREATE TABLE approval_challenges (
  project_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  run_id TEXT,
  action TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  display_artifact_digest TEXT NOT NULL,
  challenge_digest TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('approved','denied')),
  decision_digest TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, approval_id),
  UNIQUE(project_id, challenge_digest),
  UNIQUE(project_id, nonce_hash),
  UNIQUE(project_id, decision_digest),
  UNIQUE(project_id, approval_id, challenge_digest),
  CHECK (
    (run_id IS NULL AND action IN ('project-trust','project-policy','workspace-registration'))
    OR
    (run_id IS NOT NULL AND action IN ('cloud-egress','command','workspace-promotion'))
  ),
  CHECK (
    (consumed_at IS NULL AND outcome IS NULL AND decision_digest IS NULL)
    OR
    (consumed_at IS NOT NULL AND outcome IS NOT NULL AND decision_digest IS NOT NULL)
  ),
  FOREIGN KEY(project_id, run_id)
    REFERENCES runs(project_id, run_id),
  FOREIGN KEY(project_id, display_artifact_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, subject_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(policy_digest)
    REFERENCES host_authority_artifacts(object_digest),
  FOREIGN KEY(project_id, challenge_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, decision_digest)
    REFERENCES artifacts(project_id, digest)
) STRICT;

CREATE TABLE runners (
  runner_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  capability_digest TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(capability_digest)
    REFERENCES host_authority_artifacts(object_digest)
) STRICT;

CREATE TABLE runner_enrollment_challenges (
  challenge_id TEXT PRIMARY KEY,
  secret_verifier TEXT NOT NULL,
  permitted_projects_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_by_principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(permitted_projects_digest)
    REFERENCES host_authority_artifacts(object_digest)
) STRICT;

CREATE TABLE runner_certificates (
  certificate_serial TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL REFERENCES runners(runner_id),
  spki_sha256 TEXT NOT NULL,
  not_before TEXT NOT NULL,
  not_after TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT
) STRICT;

CREATE TABLE runner_project_grants (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  runner_id TEXT NOT NULL REFERENCES runners(runner_id),
  capability_policy_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(project_id, runner_id),
  FOREIGN KEY(capability_policy_digest)
    REFERENCES host_authority_artifacts(object_digest)
) STRICT;

CREATE TABLE project_standing_approval_policies (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  policy_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(project_id, policy_digest),
  FOREIGN KEY(policy_digest)
    REFERENCES host_authority_artifacts(object_digest)
) STRICT;

CREATE TABLE operation_artifacts (
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, operation_id, role, artifact_digest),
  FOREIGN KEY(project_id, operation_id)
    REFERENCES operations(project_id, operation_id),
  FOREIGN KEY(project_id, artifact_digest)
    REFERENCES artifacts(project_id, digest)
) STRICT;

CREATE TABLE cloud_call_artifacts (
  project_id TEXT NOT NULL,
  cloud_call_id TEXT NOT NULL,
  role TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, cloud_call_id, role, artifact_digest),
  FOREIGN KEY(project_id, cloud_call_id)
    REFERENCES cloud_calls(project_id, cloud_call_id),
  FOREIGN KEY(project_id, artifact_digest)
    REFERENCES artifacts(project_id, digest)
) STRICT;

CREATE TABLE project_policy_revisions (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  revision INTEGER NOT NULL,
  policy_artifact_digest TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, revision),
  UNIQUE(project_id, policy_artifact_digest),
  FOREIGN KEY(project_id, policy_artifact_digest)
    REFERENCES artifacts(project_id, digest),
  FOREIGN KEY(project_id, approval_id)
    REFERENCES approvals(project_id, approval_id)
) STRICT;

CREATE TRIGGER enforce_run_artifact_role
BEFORE INSERT ON run_artifacts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_role_registry r
    JOIN artifacts a
      ON a.project_id = NEW.project_id AND a.digest = NEW.artifact_digest
    WHERE r.owner_kind = 'run' AND r.role = NEW.role
      AND (r.artifact_schema_name IS NULL OR r.artifact_schema_name = a.schema_name)
  ) THEN RAISE(ABORT, 'unknown or schema-mismatched run artifact role') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM artifact_role_registry r
    JOIN run_artifacts x
      ON x.project_id = NEW.project_id AND x.run_id = NEW.run_id AND x.role = NEW.role
    WHERE r.owner_kind = 'run' AND r.role = NEW.role
      AND r.cardinality IN ('EXACTLY_ONE','ZERO_OR_ONE')
  ) THEN RAISE(ABORT, 'singular run artifact role already populated') END;
END;

CREATE TRIGGER enforce_snapshot_artifact_role
BEFORE INSERT ON snapshot_artifacts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_role_registry r
    JOIN artifacts a
      ON a.project_id = NEW.project_id AND a.digest = NEW.artifact_digest
    WHERE r.owner_kind = 'snapshot' AND r.role = NEW.role
      AND (r.artifact_schema_name IS NULL OR r.artifact_schema_name = a.schema_name)
  ) THEN RAISE(ABORT, 'unknown or schema-mismatched snapshot artifact role') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM artifact_role_registry r
    JOIN snapshot_artifacts x
      ON x.project_id = NEW.project_id AND x.snapshot_id = NEW.snapshot_id AND x.role = NEW.role
    WHERE r.owner_kind = 'snapshot' AND r.role = NEW.role
      AND r.cardinality IN ('EXACTLY_ONE','ZERO_OR_ONE')
  ) THEN RAISE(ABORT, 'singular snapshot artifact role already populated') END;
END;

CREATE TRIGGER enforce_operation_artifact_role
BEFORE INSERT ON operation_artifacts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_role_registry r
    JOIN artifacts a
      ON a.project_id = NEW.project_id AND a.digest = NEW.artifact_digest
    WHERE r.owner_kind = 'operation' AND r.role = NEW.role
      AND (r.artifact_schema_name IS NULL OR r.artifact_schema_name = a.schema_name)
  ) THEN RAISE(ABORT, 'unknown or schema-mismatched operation artifact role') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM artifact_role_registry r
    JOIN operation_artifacts x
      ON x.project_id = NEW.project_id AND x.operation_id = NEW.operation_id AND x.role = NEW.role
    WHERE r.owner_kind = 'operation' AND r.role = NEW.role
      AND r.cardinality IN ('EXACTLY_ONE','ZERO_OR_ONE')
  ) THEN RAISE(ABORT, 'singular operation artifact role already populated') END;
END;

CREATE TRIGGER enforce_cloud_call_artifact_role
BEFORE INSERT ON cloud_call_artifacts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_role_registry r
    JOIN artifacts a
      ON a.project_id = NEW.project_id AND a.digest = NEW.artifact_digest
    WHERE r.owner_kind = 'cloud-call' AND r.role = NEW.role
      AND (r.artifact_schema_name IS NULL OR r.artifact_schema_name = a.schema_name)
  ) THEN RAISE(ABORT, 'unknown or schema-mismatched cloud-call artifact role') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM artifact_role_registry r
    JOIN cloud_call_artifacts x
      ON x.project_id = NEW.project_id AND x.cloud_call_id = NEW.cloud_call_id AND x.role = NEW.role
    WHERE r.owner_kind = 'cloud-call' AND r.role = NEW.role
      AND r.cardinality IN ('EXACTLY_ONE','ZERO_OR_ONE')
  ) THEN RAISE(ABORT, 'singular cloud-call artifact role already populated') END;
END;

CREATE TRIGGER prevent_run_event_update
BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;

CREATE TRIGGER prevent_artifact_update
BEFORE UPDATE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifacts are immutable');
END;

CREATE TRIGGER prevent_host_authority_artifact_update
BEFORE UPDATE ON host_authority_artifacts
BEGIN
  SELECT RAISE(ABORT, 'host authority artifacts are immutable');
END;

CREATE TRIGGER enforce_approval_monotonic_update
BEFORE UPDATE ON approvals
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.approval_id IS NOT OLD.approval_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.action IS NOT OLD.action
  OR NEW.principal_id IS NOT OLD.principal_id
  OR NEW.subject_digest IS NOT OLD.subject_digest
  OR NEW.policy_digest IS NOT OLD.policy_digest
  OR NEW.challenge_digest IS NOT OLD.challenge_digest
  OR NEW.decision_digest IS NOT OLD.decision_digest
  OR NEW.grant_digest IS NOT OLD.grant_digest
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN
  SELECT RAISE(ABORT, 'approval fields are immutable or monotonic');
END;

CREATE TRIGGER enforce_approval_challenge_monotonic_update
BEFORE UPDATE ON approval_challenges
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.approval_id IS NOT OLD.approval_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.action IS NOT OLD.action
  OR NEW.principal_id IS NOT OLD.principal_id
  OR NEW.subject_digest IS NOT OLD.subject_digest
  OR NEW.policy_digest IS NOT OLD.policy_digest
  OR NEW.display_artifact_digest IS NOT OLD.display_artifact_digest
  OR NEW.challenge_digest IS NOT OLD.challenge_digest
  OR NEW.nonce_hash IS NOT OLD.nonce_hash
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
  OR (OLD.decision_digest IS NOT NULL AND NEW.decision_digest IS NOT OLD.decision_digest)
BEGIN
  SELECT RAISE(ABORT, 'approval challenge fields are immutable or monotonic');
END;

CREATE TRIGGER prevent_run_event_delete
BEFORE DELETE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;

CREATE TRIGGER prevent_usage_update
BEFORE UPDATE ON usage_entries
BEGIN
  SELECT RAISE(ABORT, 'usage corrections are append-only');
END;

CREATE TRIGGER prevent_usage_delete
BEFORE DELETE ON usage_entries
BEGIN
  SELECT RAISE(ABORT, 'usage entries are append-only');
END;

CREATE INDEX idx_run_events_run_sequence
  ON run_events(project_id, run_id, sequence);
CREATE INDEX idx_operations_claim
  ON operations(project_id, state, reclaimable, lease_until, created_at);
CREATE INDEX idx_cloud_calls_run_created
  ON cloud_calls(project_id, run_id, created_at);
CREATE INDEX idx_usage_entries_call_created
  ON usage_entries(project_id, cloud_call_id, created_at);
CREATE INDEX idx_run_artifacts_owner
  ON run_artifacts(project_id, run_id);
CREATE INDEX idx_snapshots_workspace_created
  ON snapshots(project_id, workspace_id, created_at);
CREATE INDEX idx_approvals_run_action
  ON approvals(project_id, run_id, action, created_at);
CREATE INDEX idx_approval_challenges_expiry
  ON approval_challenges(project_id, expires_at, consumed_at);
CREATE INDEX idx_runner_certificates_runner_validity
  ON runner_certificates(runner_id, not_after, revoked_at);
CREATE INDEX idx_enrollment_challenges_expiry
  ON runner_enrollment_challenges(expires_at, consumed_at);
CREATE INDEX idx_project_policy_revisions_latest
  ON project_policy_revisions(project_id, revision DESC);
