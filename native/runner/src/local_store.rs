#![allow(clippy::too_many_arguments)]
#![allow(clippy::manual_is_ascii_check)]
#![allow(clippy::suspicious_open_options)]

use crate::config::{
    canonical_json, is_object_digest, is_zero_object_digest, new_prefixed_id, nonce_256, sha256_digest_tagged,
    timestamp_now, DPAPI_KEY_ID, META_BROKER_INSTANCE, META_CA_CERT, META_CAPABILITIES, META_ED25519,
    META_KEY_ID, META_MTLS_CERT, META_MTLS_KEY, META_RUNNER_ID, RunnerConfig, RunnerError,
};
use crate::windows::{load_or_create_entropy, protect_data, unprotect_data};
use rusqlite::{Connection, OptionalExtension, Transaction};
use std::fs::{self, File, OpenOptions};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
};
use windows::Win32::System::IO::OVERLAPPED;
use zeroize::Zeroize;

const MIGRATION_SQL: &str = include_str!("../../../migrations/runner/0001_initial.sql");
const NONTERMINAL_JOURNAL_STATES: &str = "'PREPARING','PREPARED','COMMITTING','VERIFYING','ROLLING_BACK'";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundState {
    Prepared,
    InFlight,
    Completed,
    OutcomeUnknown,
}

impl OutboundState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "PREPARED",
            Self::InFlight => "IN_FLIGHT",
            Self::Completed => "COMPLETED",
            Self::OutcomeUnknown => "OUTCOME_UNKNOWN",
        }
    }

    fn parse(value: &str) -> Result<Self, RunnerError> {
        for state in [
            Self::Prepared,
            Self::InFlight,
            Self::Completed,
            Self::OutcomeUnknown,
        ] {
            if value == state.as_str() {
                return Ok(state);
            }
        }
        Err(RunnerError::Protocol("unknown outbound mutation state"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MutationPrepare {
    Send { operation_id: String, body: Vec<u8> },
    ResumeCompleted { operation_id: String, response: Vec<u8> },
    OutcomeUnknown { operation_id: String },
}

pub struct LocalStore {
    conn: Mutex<Connection>,
    db_path: PathBuf,
    entropy: [u8; 32],
    _lock: File,
}

impl LocalStore {
    pub fn open(config: &RunnerConfig) -> Result<Self, RunnerError> {
        fs::create_dir_all(&config.data_dir)?;
        let lock = acquire_exclusive_lock(&config.lock_path())?;
        let db_path = config.db_path();
        let conn = Connection::open(&db_path)?;
        conn.busy_timeout(Duration::from_millis(5000))?;
        apply_pragmas(&conn)?;
        apply_migration(&conn)?;
        let entropy = load_or_create_entropy(&config.data_dir.join("dpapi.entropy"))?;
        let store = Self {
            conn: Mutex::new(conn),
            db_path,
            entropy,
            _lock: lock,
        };
        store.reconcile_on_open()?;
        Ok(store)
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, RunnerError> {
        self.conn
            .lock()
            .map_err(|_| RunnerError::Protocol("sqlite mutex poisoned"))
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn serving_allowed(&self) -> Result<bool, RunnerError> {
        let count: i64 = self.lock_conn()?.query_row(
            "SELECT COUNT(*) FROM registered_workspaces
             WHERE recovery_state IN ('RECONCILING','MANUAL_RECOVERY_REQUIRED')",
            [],
            |row| row.get(0),
        )?;
        Ok(count == 0)
    }

    pub fn require_serving(&self) -> Result<(), RunnerError> {
        if self.serving_allowed()? {
            Ok(())
        } else {
            Err(RunnerError::Reconciling)
        }
    }

    pub fn put_metadata(&self, key: &str, value: &[u8]) -> Result<(), RunnerError> {
        let now = timestamp_now()?;
        self.lock_conn()?.execute(
            "INSERT INTO broker_metadata(key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![key, value, now],
        )?;
        Ok(())
    }

    pub fn get_metadata(&self, key: &str) -> Result<Option<Vec<u8>>, RunnerError> {
        Ok(self
            .lock_conn()?
            .query_row(
                "SELECT value FROM broker_metadata WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn store_secret(&self, key: &str, plaintext: &[u8]) -> Result<(), RunnerError> {
        let wrapped = protect_data(plaintext, &self.entropy)?;
        self.put_metadata(key, &wrapped)?;
        self.sync_durable()?;
        Ok(())
    }

    pub fn load_secret(&self, key: &str) -> Result<Vec<u8>, RunnerError> {
        let wrapped = self
            .get_metadata(key)?
            .ok_or(RunnerError::Identity("missing DPAPI identity material"))?;
        unprotect_data(&wrapped, &self.entropy)
    }

    pub fn store_ed25519_secret(&self, secret: &[u8; 32]) -> Result<(), RunnerError> {
        self.store_secret(META_ED25519, secret)
    }

    pub fn load_ed25519_secret(&self) -> Result<[u8; 32], RunnerError> {
        let mut bytes = self.load_secret(META_ED25519)?;
        if bytes.len() != 32 {
            bytes.zeroize();
            return Err(RunnerError::Identity("ed25519 secret length"));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        bytes.zeroize();
        Ok(out)
    }

    pub fn ensure_instance_id(&self) -> Result<String, RunnerError> {
        if let Some(existing) = self.get_metadata(META_BROKER_INSTANCE)? {
            return String::from_utf8(existing).map_err(|_| RunnerError::Identity("instance id utf8"));
        }
        let id = new_prefixed_id("brk_")?;
        self.put_metadata(META_BROKER_INSTANCE, id.as_bytes())?;
        Ok(id)
    }

    pub fn persist_runner_identity(
        &self,
        runner_id: &str,
        key_id: &str,
        mtls_cert_pem: &[u8],
        mtls_key_pem: &[u8],
        ca_cert_pem: &[u8],
        ed25519_secret: &[u8; 32],
    ) -> Result<(), RunnerError> {
        self.put_metadata(META_RUNNER_ID, runner_id.as_bytes())?;
        self.put_metadata(META_KEY_ID, key_id.as_bytes())?;
        self.put_metadata(META_MTLS_CERT, mtls_cert_pem)?;
        self.put_metadata(META_CA_CERT, ca_cert_pem)?;
        self.store_secret(META_MTLS_KEY, mtls_key_pem)?;
        self.store_ed25519_secret(ed25519_secret)?;
        Ok(())
    }

    pub fn enroll_identity_from_disk(&self, config: &RunnerConfig) -> Result<(), RunnerError> {
        if self.get_metadata(META_MTLS_KEY)?.is_some() && self.get_metadata(META_ED25519)?.is_some() {
            return Ok(());
        }
        let cert_path = config.identity_dir.join("mtls.crt");
        let key_path = config.identity_dir.join("mtls.key");
        let ca_path = config.identity_dir.join("ca.crt");
        let ed_path = config.identity_dir.join("ed25519.key");
        let present = cert_path.is_file() || key_path.is_file() || ca_path.is_file() || ed_path.is_file();
        if !present {
            return Ok(());
        }
        if !cert_path.is_file() || !key_path.is_file() || !ca_path.is_file() || !ed_path.is_file() {
            return Err(RunnerError::InvalidConfig("incomplete enrollment artifacts"));
        }
        let mtls_cert = fs::read(&cert_path)?;
        let mtls_key = fs::read(&key_path)?;
        let ca_cert = fs::read(&ca_path)?;
        let secret = parse_ed25519_secret(&fs::read(&ed_path)?)?;
        self.persist_runner_identity(
            &config.runner_id,
            &config.key_id,
            &mtls_cert,
            &mtls_key,
            &ca_cert,
            &secret,
        )
    }

    pub fn load_capabilities_digest(&self, capabilities_path: &Path) -> Result<String, RunnerError> {
        if capabilities_path.is_file() {
            let raw = fs::read(capabilities_path)?;
            let value: serde_json::Value =
                serde_json::from_slice(&raw).map_err(|_| RunnerError::CanonicalJson)?;
            let digest = sha256_digest_tagged(&canonical_json(&value)?);
            if is_zero_object_digest(&digest) {
                return Err(RunnerError::InvalidConfig("capabilities object digest must not be zero"));
            }
            self.put_metadata(META_CAPABILITIES, digest.as_bytes())?;
            self.sync_durable()?;
            return Ok(digest);
        }
        let Some(existing) = self.get_metadata(META_CAPABILITIES)? else {
            return Err(RunnerError::InvalidConfig("capabilities object is required"));
        };
        let digest = String::from_utf8(existing).map_err(|_| RunnerError::Identity("capabilities utf8"))?;
        if !is_object_digest(&digest) || is_zero_object_digest(&digest) {
            return Err(RunnerError::InvalidConfig("capabilities object digest is invalid"));
        }
        Ok(digest)
    }

    pub fn register_workspace(
        &self,
        workspace_id: &str,
        project_id: &str,
        root_path: &str,
        volume_identity: &str,
        root_file_identity: &str,
    ) -> Result<(), RunnerError> {
        let now = timestamp_now()?;
        let path_ct = protect_data(root_path.as_bytes(), &self.entropy)?;
        let path_nonce = nonce_256()?;
        self.lock_conn()?.execute(
            "INSERT INTO registered_workspaces (
                workspace_id, project_id, root_path_ciphertext, path_key_id, path_nonce,
                volume_identity, root_file_identity, recovery_state, active_journal_id,
                state_version, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'READY', NULL, 0, ?8, ?8)",
            rusqlite::params![
                workspace_id,
                project_id,
                path_ct,
                DPAPI_KEY_ID,
                path_nonce,
                volume_identity,
                root_file_identity,
                now
            ],
        )?;
        self.sync_durable()?;
        Ok(())
    }

    pub fn register_workspace_with_journal(
        &self,
        workspace_id: &str,
        project_id: &str,
        root_path: &str,
        volume_identity: &str,
        root_file_identity: &str,
        journal_id: &str,
        run_id: &str,
        approval_digest: &str,
        candidate_digest: &str,
        change_set_digest: &str,
        base_snapshot_digest: &str,
        expected_result_digest: &str,
        promotion_mode: &str,
    ) -> Result<(), RunnerError> {
        let now = timestamp_now()?;
        let path_ct = protect_data(root_path.as_bytes(), &self.entropy)?;
        let path_nonce = nonce_256()?;
        {
            let conn = self.lock_conn()?;
            let tx = conn.unchecked_transaction()?;
            tx.execute(
            "INSERT INTO registered_workspaces (
                workspace_id, project_id, root_path_ciphertext, path_key_id, path_nonce,
                volume_identity, root_file_identity, recovery_state, active_journal_id,
                state_version, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'READY', ?8, 0, ?9, ?9)",
            rusqlite::params![
                workspace_id,
                project_id,
                path_ct,
                DPAPI_KEY_ID,
                path_nonce,
                volume_identity,
                root_file_identity,
                journal_id,
                now
            ],
        )?;
        tx.execute(
            "INSERT INTO promotion_journals (
                journal_id, project_id, run_id, workspace_id, approval_object_digest,
                candidate_manifest_object_digest, change_set_object_digest,
                base_snapshot_root_digest, expected_result_root_digest, promotion_mode,
                state, receipt_object_digest, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'PREPARING', NULL, ?11, ?11)",
            rusqlite::params![
                journal_id,
                project_id,
                run_id,
                workspace_id,
                approval_digest,
                candidate_digest,
                change_set_digest,
                base_snapshot_digest,
                expected_result_digest,
                promotion_mode,
                now
            ],
        )?;
            tx.commit()?;
        }
        self.sync_durable()?;
        Ok(())
    }

    pub fn prepare_mutation(
        &self,
        operation_id: &str,
        project_id: Option<&str>,
        method: &str,
        target_uri: &str,
        body: &[u8],
    ) -> Result<MutationPrepare, RunnerError> {
        let digest = sha256_digest_tagged(&canonical_or_raw(body)?);
        if let Some(existing) = self.load_mutation(operation_id)? {
            if existing.digest != digest {
                return Err(RunnerError::Conflict);
            }
            return Ok(match existing.state {
                OutboundState::Prepared => MutationPrepare::Send {
                    operation_id: operation_id.to_string(),
                    body: existing.body,
                },
                OutboundState::Completed => MutationPrepare::ResumeCompleted {
                    operation_id: operation_id.to_string(),
                    response: existing
                        .response
                        .ok_or(RunnerError::Protocol("completed mutation missing response"))?,
                },
                OutboundState::InFlight | OutboundState::OutcomeUnknown => {
                    MutationPrepare::OutcomeUnknown {
                        operation_id: operation_id.to_string(),
                    }
                }
            });
        }
        let now = timestamp_now()?;
        let ciphertext = protect_data(body, &self.entropy)?;
        let nonce = nonce_256()?;
        self.lock_conn()?.execute(
            "INSERT INTO outbound_mutations (
                operation_id, project_id, method, target_uri, semantic_request_digest,
                request_artifact_ciphertext, request_key_id, request_nonce, state,
                response_artifact_ciphertext, response_key_id, response_nonce,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PREPARED', NULL, NULL, NULL, ?9, ?9)",
            rusqlite::params![
                operation_id,
                project_id,
                method,
                target_uri,
                digest,
                ciphertext,
                DPAPI_KEY_ID,
                nonce,
                now
            ],
        )?;
        self.sync_durable()?;
        Ok(MutationPrepare::Send {
            operation_id: operation_id.to_string(),
            body: body.to_vec(),
        })
    }

    pub fn mark_in_flight(&self, operation_id: &str) -> Result<(), RunnerError> {
        let now = timestamp_now()?;
        let changed = self.lock_conn()?.execute(
            "UPDATE outbound_mutations SET state = 'IN_FLIGHT', updated_at = ?2
             WHERE operation_id = ?1 AND state = 'PREPARED'",
            rusqlite::params![operation_id, now],
        )?;
        if changed != 1 {
            return Err(RunnerError::Conflict);
        }
        self.sync_durable()?;
        Ok(())
    }

    pub fn mark_completed(&self, operation_id: &str, response: &[u8]) -> Result<(), RunnerError> {
        let now = timestamp_now()?;
        let ciphertext = protect_data(response, &self.entropy)?;
        let nonce = nonce_256()?;
        let changed = self.lock_conn()?.execute(
            "UPDATE outbound_mutations SET
                state = 'COMPLETED',
                response_artifact_ciphertext = ?2,
                response_key_id = ?3,
                response_nonce = ?4,
                updated_at = ?5
             WHERE operation_id = ?1 AND state IN ('PREPARED', 'IN_FLIGHT')",
            rusqlite::params![operation_id, ciphertext, DPAPI_KEY_ID, nonce, now],
        )?;
        if changed != 1 {
            return Err(RunnerError::Conflict);
        }
        self.sync_durable()?;
        Ok(())
    }

    pub fn mark_outcome_unknown(&self, operation_id: &str) -> Result<(), RunnerError> {
        let now = timestamp_now()?;
        self.lock_conn()?.execute(
            "UPDATE outbound_mutations SET state = 'OUTCOME_UNKNOWN', updated_at = ?2
             WHERE operation_id = ?1 AND state = 'IN_FLIGHT'",
            rusqlite::params![operation_id, now],
        )?;
        self.sync_durable()?;
        Ok(())
    }

    pub fn mutation_state(&self, operation_id: &str) -> Result<Option<OutboundState>, RunnerError> {
        Ok(self.load_mutation(operation_id)?.map(|row| row.state))
    }

    pub fn open_trusted_session(
        &self,
        challenge_digest: &str,
        subject_digest: &str,
        expires_at: &str,
    ) -> Result<(String, String), RunnerError> {
        let now = timestamp_now()?;
        let session_id = new_prefixed_id("tui_")?;
        let nonce = nonce_256()?;
        let nonce_hash = sha256_digest_tagged(nonce.as_bytes());
        self.lock_conn()?.execute(
            "INSERT INTO trusted_ui_sessions (
                trusted_ui_session_id, challenge_object_digest, subject_object_digest,
                nonce_hash, ui_process_id, ui_process_creation_time, state,
                decision_object_digest, expires_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, 'CREATED', NULL, ?5, ?6, ?6)",
            rusqlite::params![
                session_id,
                challenge_digest,
                subject_digest,
                nonce_hash,
                expires_at,
                now
            ],
        )?;
        self.sync_durable()?;
        Ok((session_id, nonce))
    }

    pub fn consume_trusted_nonce(&self, nonce: &str, decision_digest: &str) -> Result<(), RunnerError> {
        let now = timestamp_now()?;
        let nonce_hash = sha256_digest_tagged(nonce.as_bytes());
        let conn = self.lock_conn()?;
        let current: Option<String> = conn
            .query_row(
                "SELECT state FROM trusted_ui_sessions WHERE nonce_hash = ?1",
                rusqlite::params![nonce_hash],
                |row| row.get(0),
            )
            .optional()?;
        match current.as_deref() {
            None => return Err(RunnerError::NotFound),
            Some("CREATED" | "DISPLAYED") => {}
            Some(_) => return Err(RunnerError::Conflict),
        }
        let changed = conn.execute(
            "UPDATE trusted_ui_sessions
             SET state = 'DECIDED', decision_object_digest = ?2, updated_at = ?3
             WHERE nonce_hash = ?1 AND state IN ('CREATED','DISPLAYED')",
            rusqlite::params![nonce_hash, decision_digest, now],
        )?;
        drop(conn);
        if changed != 1 {
            return Err(RunnerError::Conflict);
        }
        self.sync_durable()?;
        Ok(())
    }

    pub fn lookup_workspace(
        &self,
        workspace_alias: &str,
    ) -> Result<Option<(String, String, String)>, RunnerError> {
        Ok(self
            .lock_conn()?
            .query_row(
                "SELECT workspace_id, project_id, recovery_state FROM registered_workspaces
                 WHERE workspace_id = ?1",
                [workspace_alias],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?)
    }

    pub fn bind_run(&self, run_id: &str, project_id: &str, workspace_id: &str) -> Result<(), RunnerError> {
        let payload = serde_json::json!({
            "projectId": project_id,
            "workspaceId": workspace_id
        });
        self.put_metadata(&format!("run:{run_id}"), &canonical_json(&payload)?)?;
        Ok(())
    }

    pub fn lookup_run(&self, run_id: &str) -> Result<Option<(String, String)>, RunnerError> {
        let Some(bytes) = self.get_metadata(&format!("run:{run_id}"))? else {
            return Ok(None);
        };
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| RunnerError::CanonicalJson)?;
        let project = value
            .get("projectId")
            .and_then(|v| v.as_str())
            .ok_or(RunnerError::NotFound)?
            .to_string();
        let workspace = value
            .get("workspaceId")
            .and_then(|v| v.as_str())
            .ok_or(RunnerError::NotFound)?
            .to_string();
        Ok(Some((project, workspace)))
    }

    fn load_mutation(&self, operation_id: &str) -> Result<Option<MutationRow>, RunnerError> {
        let row = self
            .lock_conn()?
            .query_row(
                "SELECT state, semantic_request_digest, request_artifact_ciphertext, response_artifact_ciphertext
                 FROM outbound_mutations WHERE operation_id = ?1",
                [operation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                        row.get::<_, Option<Vec<u8>>>(3)?,
                    ))
                },
            )
            .optional()?;
        match row {
            None => Ok(None),
            Some((state, digest, request_ct, response_ct)) => {
                let body = unprotect_data(&request_ct, &self.entropy)?;
                let response = match response_ct {
                    Some(ct) => Some(unprotect_data(&ct, &self.entropy)?),
                    None => None,
                };
                Ok(Some(MutationRow {
                    state: OutboundState::parse(&state)?,
                    digest,
                    body,
                    response,
                }))
            }
        }
    }

    fn reconcile_on_open(&self) -> Result<(), RunnerError> {
        let now = timestamp_now()?;
        {
            let conn = self.lock_conn()?;
            conn.execute(
                "UPDATE outbound_mutations SET state = 'OUTCOME_UNKNOWN', updated_at = ?1
             WHERE state = 'IN_FLIGHT'",
                rusqlite::params![now],
            )?;
            let tx: Transaction<'_> = conn.unchecked_transaction()?;
            tx.execute(
                &format!(
                    "UPDATE registered_workspaces SET recovery_state = 'RECONCILING', updated_at = ?1
                 WHERE workspace_id IN (
                    SELECT workspace_id FROM promotion_journals WHERE state IN ({NONTERMINAL_JOURNAL_STATES})
                 )"
                ),
                rusqlite::params![now],
            )?;
            tx.commit()?;
        }
        self.sync_durable()?;
        crate::promotion::reconcile_all(self).map_err(|_| RunnerError::Reconciling)?;
        Ok(())
    }

    pub(crate) fn with_conn<F, T>(&self, f: F) -> Result<T, RunnerError>
    where
        F: FnOnce(&Connection) -> Result<T, RunnerError>,
    {
        let conn = self.lock_conn()?;
        f(&conn)
    }

    pub(crate) fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, RunnerError> {
        protect_data(plaintext, &self.entropy)
    }

    pub(crate) fn unprotect(&self, ciphertext: &[u8]) -> Result<Vec<u8>, RunnerError> {
        unprotect_data(ciphertext, &self.entropy)
    }

    pub(crate) fn fsync_store(&self) -> Result<(), RunnerError> {
        self.sync_durable()
    }

    pub(crate) fn put_cas_blob(&self, digest: &str, ciphertext: &[u8]) -> Result<(), RunnerError> {
        let dir = match self.db_path.parent() {
            Some(parent) => parent,
            None => Path::new("."),
        };
        let path = dir.join("rollback").join(digest.replace(':', "_"));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, ciphertext)?;
        File::options().read(true).write(true).open(&path)?.sync_all()?;
        Ok(())
    }

    pub(crate) fn get_cas_blob(&self, digest: &str) -> Result<Option<Vec<u8>>, RunnerError> {
        let dir = match self.db_path.parent() {
            Some(parent) => parent,
            None => Path::new("."),
        };
        let path = dir.join("rollback").join(digest.replace(':', "_"));
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(fs::read(path)?))
    }

    fn sync_durable(&self) -> Result<(), RunnerError> {
        {
            let conn = self.lock_conn()?;
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)");
        }
        File::options()
            .read(true)
            .write(true)
            .open(&self.db_path)?
            .sync_all()?;
        let wal = PathBuf::from(format!("{}-wal", self.db_path.display()));
        if wal.exists() {
            File::options().read(true).write(true).open(&wal)?.sync_all()?;
        }
        Ok(())
    }
}

struct MutationRow {
    state: OutboundState,
    digest: String,
    body: Vec<u8>,
    response: Option<Vec<u8>>,
}

fn parse_ed25519_secret(bytes: &[u8]) -> Result<[u8; 32], RunnerError> {
    if bytes.len() == 32 {
        let mut out = [0u8; 32];
        out.copy_from_slice(bytes);
        return Ok(out);
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| RunnerError::Identity("ed25519 secret utf8"))?
        .trim();
    if text.len() != 64 || !text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F')) {
        return Err(RunnerError::Identity("ed25519 secret length"));
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16)
            .map_err(|_| RunnerError::Identity("ed25519 secret hex"))?;
    }
    Ok(out)
}

fn canonical_or_raw(body: &[u8]) -> Result<Vec<u8>, RunnerError> {
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) {
        canonical_json(&value)
    } else {
        Ok(body.to_vec())
    }
}

fn apply_pragmas(conn: &Connection) -> Result<(), RunnerError> {
    let journal: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    if !journal.eq_ignore_ascii_case("wal") {
        return Err(RunnerError::Sqlite(rusqlite::Error::InvalidQuery));
    }
    conn.execute_batch(
        "PRAGMA synchronous = FULL;
         PRAGMA foreign_keys = ON;
         PRAGMA trusted_schema = OFF;",
    )?;
    Ok(())
}

fn apply_migration(conn: &Connection) -> Result<(), RunnerError> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'broker_metadata'",
        [],
        |row| row.get(0),
    )?;
    if exists == 0 {
        conn.execute_batch(MIGRATION_SQL)?;
    }
    Ok(())
}

fn acquire_exclusive_lock(path: &Path) -> Result<File, RunnerError> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)?;
    let mut overlapped = OVERLAPPED::default();
    unsafe {
        LockFileEx(
            HANDLE(file.as_raw_handle()),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            None,
            1,
            0,
            &mut overlapped,
        )
        .map_err(|_| RunnerError::LockHeld)?;
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::{LocalStore, MutationPrepare, OutboundState};
    use crate::config::RunnerConfig;
    use std::fs;
    use std::path::PathBuf;

    fn temp_config(name: &str) -> RunnerConfig {
        let dir = std::env::temp_dir().join(format!(
            "pi-hec-runner-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        RunnerConfig {
            data_dir: dir.clone(),
            control_base_url: "https://control.local".into(),
            runner_id: "runner-test".into(),
            key_id: "key-test".into(),
            pi_executable: PathBuf::from("pi.exe"),
            pi_args: Vec::new(),
            pi_stdio_log: None,
            identity_dir: dir.join("identity"),
            capabilities_path: dir.join("capabilities.json"),
        }
    }

    #[test]
    fn prepared_fsyncs_before_send_and_in_flight_becomes_unknown() {
        let config = temp_config("mutation");
        let op = "op_01900000-0000-7000-8000-000000000001";
        let body = br#"{"schemaVersion":1,"maxJobs":1}"#;
        {
            let store = LocalStore::open(&config).unwrap();
            let prepared = store
                .prepare_mutation(op, Some("proj"), "leaseRunnerJob", "https://c/v1/runner/jobs:lease", body)
                .unwrap();
            match prepared {
                MutationPrepare::Send { operation_id, .. } => assert_eq!(operation_id, op),
                other => panic!("{other:?}"),
            }
            assert_eq!(store.mutation_state(op).unwrap(), Some(OutboundState::Prepared));
            store.mark_in_flight(op).unwrap();
            assert_eq!(store.mutation_state(op).unwrap(), Some(OutboundState::InFlight));
        }
        let store = LocalStore::open(&config).unwrap();
        assert_eq!(
            store.mutation_state(op).unwrap(),
            Some(OutboundState::OutcomeUnknown)
        );
        let other = br#"{"schemaVersion":1,"maxJobs":1,"changed":true}"#;
        let conflict = store.prepare_mutation(
            op,
            Some("proj"),
            "leaseRunnerJob",
            "https://c/v1/runner/jobs:lease",
            other,
        );
        assert!(matches!(conflict, Err(crate::config::RunnerError::Conflict)));
        let resume = store
            .prepare_mutation(op, Some("proj"), "leaseRunnerJob", "https://c/v1/runner/jobs:lease", body)
            .unwrap();
        assert!(matches!(resume, MutationPrepare::OutcomeUnknown { .. }));
    }

    #[test]
    fn exclusive_lock_and_reconciling_refuses_serving() {
        let config = temp_config("lock");
        let first = LocalStore::open(&config).unwrap();
        let second = LocalStore::open(&config);
        assert!(matches!(second, Err(crate::config::RunnerError::LockHeld)));
        first.store_ed25519_secret(&[7u8; 32]).unwrap();
        first
            .register_workspace_with_journal(
                "ws1",
                "proj1",
                r"C:\work\repo",
                "vol",
                "root",
                "journal-1",
                "run_01900000-0000-7000-8000-000000000002",
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                "ENTRY_JOURNALED",
            )
            .unwrap();
        drop(first);
        let reopened = LocalStore::open(&config).unwrap();
        assert!(reopened.serving_allowed().unwrap());
        assert!(reopened.require_serving().is_ok());
    }

    #[test]
    fn dpapi_secret_is_absent_from_db_bytes() {
        let config = temp_config("dpapi-file");
        let secret = *b"0123456789abcdef0123456789abcdef";
        let store = LocalStore::open(&config).unwrap();
        store.store_ed25519_secret(&secret).unwrap();
        let loaded = store.load_ed25519_secret().unwrap();
        assert_eq!(loaded, secret);
        let raw = fs::read(store.db_path()).unwrap();
        assert!(!raw.windows(secret.len()).any(|window| window == secret));
    }

    #[test]
    fn ensure_registered_workspace_is_idempotent() {
        let config = temp_config("ws-boot");
        let store = LocalStore::open(&config).unwrap();
        crate::operations::ensure_registered_workspace(
            &store,
            "pi-hec-prod-e2e",
            "live.hec.task",
            r"C:\tmp\pi-hec-prod-e2e",
            "vol",
            "root",
        )
        .unwrap();
        crate::operations::ensure_registered_workspace(
            &store,
            "pi-hec-prod-e2e",
            "other.project",
            r"C:\tmp\other",
            "vol-other",
            "root-other",
        )
        .unwrap();
        let found = store.lookup_workspace("pi-hec-prod-e2e").unwrap().expect("workspace");
        assert_eq!(found.0, "pi-hec-prod-e2e");
        assert_eq!(found.1, "live.hec.task");
        assert_eq!(found.2, "READY");
    }

    #[test]
    fn persist_runner_identity_from_enrollment_artifacts() {
        let config = temp_config("identity-enroll");
        fs::create_dir_all(&config.identity_dir).unwrap();
        fs::write(config.identity_dir.join("mtls.crt"), b"-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n").unwrap();
        fs::write(config.identity_dir.join("mtls.key"), b"-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n").unwrap();
        fs::write(config.identity_dir.join("ca.crt"), b"-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n").unwrap();
        let secret = *b"abcdef0123456789abcdef0123456789";
        fs::write(config.identity_dir.join("ed25519.key"), secret).unwrap();
        let store = LocalStore::open(&config).unwrap();
        store.enroll_identity_from_disk(&config).unwrap();
        assert_eq!(store.load_ed25519_secret().unwrap(), secret);
        assert_eq!(
            store.get_metadata(crate::config::META_RUNNER_ID).unwrap().unwrap(),
            b"runner-test"
        );
        let capabilities = serde_json::json!({"schemaVersion":1,"platform":"windows","maxJobs":1});
        fs::write(
            &config.capabilities_path,
            serde_json_canonicalizer::to_vec(&capabilities).unwrap(),
        )
        .unwrap();
        let digest = store.load_capabilities_digest(&config.capabilities_path).unwrap();
        assert!(digest.starts_with("sha256:"));
        assert_ne!(digest, crate::config::ZERO_OBJECT_DIGEST);
        store
            .put_metadata(crate::config::META_CAPABILITIES, crate::config::ZERO_OBJECT_DIGEST.as_bytes())
            .unwrap();
        let _ = fs::remove_file(&config.capabilities_path);
        assert!(store.load_capabilities_digest(&config.capabilities_path).is_err());
    }
}
