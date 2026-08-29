CREATE TABLE broker_metadata (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE registered_workspaces (
  workspace_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_path_ciphertext BLOB NOT NULL,
  path_key_id TEXT NOT NULL,
  path_nonce TEXT NOT NULL,
  volume_identity TEXT NOT NULL,
  root_file_identity TEXT NOT NULL,
  recovery_state TEXT NOT NULL
    CHECK (recovery_state IN ('READY','RECONCILING','MANUAL_RECOVERY_REQUIRED')),
  active_journal_id TEXT,
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(path_key_id, path_nonce),
  UNIQUE(project_id, volume_identity, root_file_identity),
  FOREIGN KEY(active_journal_id)
    REFERENCES promotion_journals(journal_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE outbound_mutations (
  operation_id TEXT PRIMARY KEY,
  project_id TEXT,
  method TEXT NOT NULL,
  target_uri TEXT NOT NULL,
  semantic_request_digest TEXT NOT NULL,
  request_artifact_ciphertext BLOB NOT NULL,
  request_key_id TEXT NOT NULL,
  request_nonce TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('PREPARED','IN_FLIGHT','COMPLETED','OUTCOME_UNKNOWN')),
  response_artifact_ciphertext BLOB,
  response_key_id TEXT,
  response_nonce TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(request_key_id, request_nonce),
  UNIQUE(response_key_id, response_nonce),
  CHECK (
    (state IN ('PREPARED','IN_FLIGHT','OUTCOME_UNKNOWN')
      AND response_artifact_ciphertext IS NULL
      AND response_key_id IS NULL AND response_nonce IS NULL)
    OR
    (state = 'COMPLETED'
      AND response_artifact_ciphertext IS NOT NULL
      AND response_key_id IS NOT NULL AND response_nonce IS NOT NULL)
  )
) STRICT;

CREATE TABLE promotion_journals (
  journal_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  approval_object_digest TEXT NOT NULL,
  candidate_manifest_object_digest TEXT NOT NULL,
  change_set_object_digest TEXT NOT NULL,
  base_snapshot_root_digest TEXT NOT NULL,
  expected_result_root_digest TEXT NOT NULL,
  promotion_mode TEXT NOT NULL
    CHECK (promotion_mode IN ('ENTRY_JOURNALED','ROOT_SWAP')),
  state TEXT NOT NULL
    CHECK (state IN (
      'PREPARING','PREPARED','COMMITTING','VERIFYING',
      'ROLLING_BACK','COMMITTED','ROLLED_BACK','STALE',
      'MANUAL_RECOVERY_REQUIRED'
    )),
  receipt_object_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id)
    REFERENCES registered_workspaces(workspace_id),
  CHECK (
    (state IN ('COMMITTED','ROLLED_BACK','STALE','MANUAL_RECOVERY_REQUIRED')
      AND receipt_object_digest IS NOT NULL)
    OR
    (state NOT IN ('COMMITTED','ROLLED_BACK','STALE','MANUAL_RECOVERY_REQUIRED')
      AND receipt_object_digest IS NULL)
  )
) STRICT;

CREATE TABLE rollback_objects (
  object_digest TEXT PRIMARY KEY,
  ciphertext_path TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  encryption_key_id TEXT NOT NULL,
  encryption_nonce TEXT NOT NULL,
  ref_count INTEGER NOT NULL CHECK (ref_count > 0),
  created_at TEXT NOT NULL,
  UNIQUE(encryption_key_id, encryption_nonce)
) STRICT;

CREATE TABLE promotion_entries (
  journal_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  operation_kind TEXT NOT NULL,
  relative_path_ciphertext BLOB NOT NULL,
  path_key_id TEXT NOT NULL,
  path_nonce TEXT NOT NULL,
  expected_before_digest TEXT,
  expected_after_digest TEXT,
  rollback_object_digest TEXT,
  entry_state TEXT NOT NULL
    CHECK (entry_state IN ('PENDING','STAGED','APPLIED','ROLLED_BACK','EXTERNAL_CONFLICT')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(journal_id, sequence),
  UNIQUE(path_key_id, path_nonce),
  FOREIGN KEY(journal_id)
    REFERENCES promotion_journals(journal_id),
  FOREIGN KEY(rollback_object_digest)
    REFERENCES rollback_objects(object_digest)
) STRICT;

CREATE TABLE trusted_ui_sessions (
  trusted_ui_session_id TEXT PRIMARY KEY,
  challenge_object_digest TEXT NOT NULL,
  subject_object_digest TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  ui_process_id INTEGER,
  ui_process_creation_time TEXT,
  state TEXT NOT NULL CHECK (state IN ('CREATED','DISPLAYED','DECIDED','EXPIRED')),
  decision_object_digest TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'DECIDED' AND decision_object_digest IS NOT NULL)
    OR
    (state <> 'DECIDED' AND decision_object_digest IS NULL)
  )
) STRICT;
