use crate::config::{
    canonical_json, new_prefixed_id, nonce_256, sha256_digest_tagged, timestamp_now, DPAPI_KEY_ID, RunnerError,
};
use crate::local_store::LocalStore;
use rusqlite::{OptionalExtension, params};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct JournalRow {
    pub journal_id: String,
    pub project_id: String,
    pub run_id: String,
    pub workspace_id: String,
    pub approval_object_digest: String,
    pub candidate_manifest_object_digest: String,
    pub change_set_object_digest: String,
    pub base_snapshot_root_digest: String,
    pub expected_result_root_digest: String,
    pub promotion_mode: String,
    pub state: String,
    pub receipt_object_digest: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EntryRow {
    pub sequence: i64,
    pub operation_kind: String,
    pub relative_path: String,
    pub expected_before_digest: Option<String>,
    pub expected_after_digest: Option<String>,
    pub rollback_object_digest: Option<String>,
    pub entry_state: String,
}

pub fn list_nonterminal(store: &LocalStore) -> Result<Vec<JournalRow>, RunnerError> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT journal_id, project_id, run_id, workspace_id, approval_object_digest,
                    candidate_manifest_object_digest, change_set_object_digest,
                    base_snapshot_root_digest, expected_result_root_digest, promotion_mode,
                    state, receipt_object_digest
             FROM promotion_journals
             WHERE state IN ('PREPARING','PREPARED','COMMITTING','VERIFYING','ROLLING_BACK')
             ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(JournalRow {
                journal_id: row.get(0)?,
                project_id: row.get(1)?,
                run_id: row.get(2)?,
                workspace_id: row.get(3)?,
                approval_object_digest: row.get(4)?,
                candidate_manifest_object_digest: row.get(5)?,
                change_set_object_digest: row.get(6)?,
                base_snapshot_root_digest: row.get(7)?,
                expected_result_root_digest: row.get(8)?,
                promotion_mode: row.get(9)?,
                state: row.get(10)?,
                receipt_object_digest: row.get(11)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

pub fn load_journal(store: &LocalStore, journal_id: &str) -> Result<Option<JournalRow>, RunnerError> {
    store.with_conn(|conn| {
        conn.query_row(
            "SELECT journal_id, project_id, run_id, workspace_id, approval_object_digest,
                    candidate_manifest_object_digest, change_set_object_digest,
                    base_snapshot_root_digest, expected_result_root_digest, promotion_mode,
                    state, receipt_object_digest
             FROM promotion_journals WHERE journal_id = ?1",
            [journal_id],
            |row| {
                Ok(JournalRow {
                    journal_id: row.get(0)?,
                    project_id: row.get(1)?,
                    run_id: row.get(2)?,
                    workspace_id: row.get(3)?,
                    approval_object_digest: row.get(4)?,
                    candidate_manifest_object_digest: row.get(5)?,
                    change_set_object_digest: row.get(6)?,
                    base_snapshot_root_digest: row.get(7)?,
                    expected_result_root_digest: row.get(8)?,
                    promotion_mode: row.get(9)?,
                    state: row.get(10)?,
                    receipt_object_digest: row.get(11)?,
                })
            },
        )
        .optional()
        .map_err(RunnerError::from)
    })
}

pub fn workspace_root_path(store: &LocalStore, workspace_id: &str) -> Result<Option<String>, RunnerError> {
    let ciphertext: Option<Vec<u8>> = store.with_conn(|conn| {
        conn.query_row(
            "SELECT root_path_ciphertext FROM registered_workspaces WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(RunnerError::from)
    })?;
    match ciphertext {
        Some(bytes) => Ok(Some(String::from_utf8(store.unprotect(&bytes)?).map_err(|_| {
            RunnerError::Identity("workspace path utf8")
        })?)),
        None => Ok(None),
    }
}

pub fn workspace_recovery(store: &LocalStore, workspace_id: &str) -> Result<Option<(String, Option<String>)>, RunnerError> {
    store.with_conn(|conn| {
        conn.query_row(
            "SELECT recovery_state, active_journal_id FROM registered_workspaces WHERE workspace_id = ?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(RunnerError::from)
    })
}

pub fn load_entries(store: &LocalStore, journal_id: &str) -> Result<Vec<EntryRow>, RunnerError> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT sequence, operation_kind, relative_path_ciphertext, expected_before_digest,
                    expected_after_digest, rollback_object_digest, entry_state
             FROM promotion_entries WHERE journal_id = ?1 ORDER BY sequence",
        )?;
        let rows = stmt.query_map([journal_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (sequence, operation_kind, path_ct, expected_before_digest, expected_after_digest, rollback_object_digest, entry_state) =
                row?;
            let relative_path = String::from_utf8(store.unprotect(&path_ct)?)
                .map_err(|_| RunnerError::Identity("entry path utf8"))?;
            out.push(EntryRow {
                sequence,
                operation_kind,
                relative_path,
                expected_before_digest,
                expected_after_digest,
                rollback_object_digest,
                entry_state,
            });
        }
        Ok(out)
    })
}

pub fn put_cas_object(store: &LocalStore, bytes: &[u8]) -> Result<String, RunnerError> {
    let digest = sha256_digest_tagged(bytes);
    let ciphertext = store.protect(bytes)?;
    let nonce = nonce_256()?;
    let now = timestamp_now()?;
    let path = format!("rollback/{digest}");
    store.with_conn(|conn| {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM rollback_objects WHERE object_digest = ?1",
            [&digest],
            |row| row.get(0),
        )?;
        if exists == 0 {
            conn.execute(
                "INSERT INTO rollback_objects (
                    object_digest, ciphertext_path, byte_size, encryption_key_id, encryption_nonce,
                    ref_count, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                params![digest, path, bytes.len() as i64, DPAPI_KEY_ID, nonce, now],
            )?;
        } else {
            conn.execute(
                "UPDATE rollback_objects SET ref_count = ref_count + 1 WHERE object_digest = ?1",
                [&digest],
            )?;
        }
        Ok(())
    })?;
    store.put_cas_blob(&digest, &ciphertext)?;
    store.fsync_store()?;
    Ok(digest)
}

pub fn get_cas_object(store: &LocalStore, digest: &str) -> Result<Vec<u8>, RunnerError> {
    let wrapped = store
        .get_cas_blob(digest)?
        .ok_or(RunnerError::NotFound)?;
    store.unprotect(&wrapped)
}

#[allow(clippy::too_many_arguments)]
pub fn begin_journal(
    store: &LocalStore,
    workspace_id: &str,
    project_id: &str,
    root_path: &str,
    volume_identity: &str,
    root_file_identity: &str,
    run_id: &str,
    approval_digest: &str,
    candidate_digest: &str,
    change_set_digest: &str,
    base_snapshot_digest: &str,
    expected_result_digest: &str,
    promotion_mode: &str,
) -> Result<String, RunnerError> {
    let now = timestamp_now()?;
    let journal_id = new_prefixed_id("jnl_")?;
    let _ = (root_path, volume_identity, root_file_identity);
    let existing = store.lookup_workspace(workspace_id)?;
    if existing.is_none() {
        return Err(RunnerError::NotFound);
    }
    store.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE registered_workspaces
             SET recovery_state = 'RECONCILING', active_journal_id = ?2, updated_at = ?3,
                 state_version = state_version + 1
             WHERE workspace_id = ?1 AND recovery_state = 'READY'",
            params![workspace_id, journal_id, now],
        )?;
        if changed != 1 {
            return Err(RunnerError::Conflict);
        }
        tx.execute(
            "INSERT INTO promotion_journals (
                journal_id, project_id, run_id, workspace_id, approval_object_digest,
                candidate_manifest_object_digest, change_set_object_digest,
                base_snapshot_root_digest, expected_result_root_digest, promotion_mode,
                state, receipt_object_digest, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'PREPARING', NULL, ?11, ?11)",
            params![
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
        Ok(())
    })?;
    store.fsync_store()?;
    Ok(journal_id)
}

#[allow(clippy::too_many_arguments)]
pub fn insert_entry(
    store: &LocalStore,
    journal_id: &str,
    sequence: i64,
    kind: &str,
    relative_path: &str,
    before: Option<&str>,
    after: Option<&str>,
    rollback: Option<&str>,
    state: &str,
) -> Result<(), RunnerError> {
    let now = timestamp_now()?;
    let path_ct = store.protect(relative_path.as_bytes())?;
    let path_nonce = nonce_256()?;
    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO promotion_entries (
                journal_id, sequence, operation_kind, relative_path_ciphertext, path_key_id, path_nonce,
                expected_before_digest, expected_after_digest, rollback_object_digest, entry_state, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                journal_id,
                sequence,
                kind,
                path_ct,
                DPAPI_KEY_ID,
                path_nonce,
                before,
                after,
                rollback,
                state,
                now
            ],
        )?;
        Ok(())
    })?;
    store.fsync_store()?;
    Ok(())
}

pub fn set_journal_state(
    store: &LocalStore,
    journal_id: &str,
    state: &str,
    receipt: Option<&str>,
) -> Result<(), RunnerError> {
    let now = timestamp_now()?;
    store.with_conn(|conn| {
        conn.execute(
            "UPDATE promotion_journals SET state = ?2, receipt_object_digest = ?3, updated_at = ?4
             WHERE journal_id = ?1",
            params![journal_id, state, receipt, now],
        )?;
        Ok(())
    })?;
    store.fsync_store()?;
    Ok(())
}

pub fn set_entry_state(store: &LocalStore, journal_id: &str, sequence: i64, state: &str) -> Result<(), RunnerError> {
    let now = timestamp_now()?;
    store.with_conn(|conn| {
        conn.execute(
            "UPDATE promotion_entries SET entry_state = ?3, updated_at = ?4
             WHERE journal_id = ?1 AND sequence = ?2",
            params![journal_id, sequence, state, now],
        )?;
        Ok(())
    })?;
    store.fsync_store()?;
    Ok(())
}

pub fn drop_lease(store: &LocalStore, workspace_id: &str, recovery_state: &str) -> Result<(), RunnerError> {
    let now = timestamp_now()?;
    store.with_conn(|conn| {
        conn.execute(
            "UPDATE registered_workspaces
             SET recovery_state = ?2, active_journal_id = NULL, updated_at = ?3,
                 state_version = state_version + 1
             WHERE workspace_id = ?1",
            params![workspace_id, recovery_state, now],
        )?;
        Ok(())
    })?;
    store.fsync_store()?;
    Ok(())
}

pub fn set_workspace_recovery(store: &LocalStore, workspace_id: &str, recovery_state: &str) -> Result<(), RunnerError> {
    let now = timestamp_now()?;
    store.with_conn(|conn| {
        conn.execute(
            "UPDATE registered_workspaces SET recovery_state = ?2, updated_at = ?3 WHERE workspace_id = ?1",
            params![workspace_id, recovery_state, now],
        )?;
        Ok(())
    })?;
    store.fsync_store()?;
    Ok(())
}

pub fn consume_grant(store: &LocalStore, grant_digest: &str) -> Result<(), RunnerError> {
    let now = timestamp_now()?;
    let key = format!("grant-consumed:{grant_digest}");
    let result = store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO broker_metadata(key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, b"consumed".as_slice(), now],
        )?;
        Ok(())
    });
    match result {
        Ok(()) => {
            store.fsync_store()?;
            Ok(())
        }
        Err(RunnerError::Sqlite(err)) if err.to_string().contains("UNIQUE") => Err(RunnerError::Conflict),
        Err(err) => Err(err),
    }
}

pub fn journal_plan_digest(entries: &[EntryRow]) -> Result<String, RunnerError> {
    let payload = json!({
        "entries": entries.iter().map(|entry| {
            json!({
                "sequence": entry.sequence,
                "kind": entry.operation_kind,
                "path": entry.relative_path,
                "before": entry.expected_before_digest,
                "after": entry.expected_after_digest
            })
        }).collect::<Vec<Value>>()
    });
    Ok(sha256_digest_tagged(&canonical_json(&payload)?))
}

pub fn list_receipted_held_leases(store: &LocalStore) -> Result<Vec<(String, String)>, RunnerError> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT w.workspace_id, j.state
             FROM registered_workspaces w
             INNER JOIN promotion_journals j ON j.journal_id = w.active_journal_id
             WHERE j.receipt_object_digest IS NOT NULL
               AND j.state IN ('COMMITTED','STALE','ROLLED_BACK','MANUAL_RECOVERY_REQUIRED')",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

pub fn store_apply_context(
    store: &LocalStore,
    journal_id: &str,
    approval_id: &str,
    signature_key_id: &str,
    signer_certificate_object_digest: &str,
) -> Result<(), RunnerError> {
    let payload = json!({
        "approvalId": approval_id,
        "signatureKeyId": signature_key_id,
        "signerCertificateObjectDigest": signer_certificate_object_digest
    });
    store.put_metadata(&format!("journal-ctx:{journal_id}"), &canonical_json(&payload)?)?;
    store.fsync_store()?;
    Ok(())
}

pub fn load_apply_context(store: &LocalStore, journal_id: &str) -> Result<Option<(String, String, String)>, RunnerError> {
    let Some(bytes) = store.get_metadata(&format!("journal-ctx:{journal_id}"))? else {
        return Ok(None);
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| RunnerError::CanonicalJson)?;
    let approval = value
        .get("approvalId")
        .and_then(Value::as_str)
        .ok_or(RunnerError::CanonicalJson)?
        .to_string();
    let key_id = value
        .get("signatureKeyId")
        .and_then(Value::as_str)
        .ok_or(RunnerError::CanonicalJson)?
        .to_string();
    let cert = value
        .get("signerCertificateObjectDigest")
        .and_then(Value::as_str)
        .ok_or(RunnerError::CanonicalJson)?
        .to_string();
    Ok(Some((approval, key_id, cert)))
}

pub fn store_entry_meta(store: &LocalStore, journal_id: &str, sequence: i64, meta: &Value) -> Result<(), RunnerError> {
    store.put_metadata(
        &format!("entry-meta:{journal_id}:{sequence}"),
        &canonical_json(meta)?,
    )?;
    store.fsync_store()?;
    Ok(())
}

pub fn load_entry_meta(store: &LocalStore, journal_id: &str, sequence: i64) -> Result<Option<Value>, RunnerError> {
    let Some(bytes) = store.get_metadata(&format!("entry-meta:{journal_id}:{sequence}"))? else {
        return Ok(None);
    };
    Ok(Some(serde_json::from_slice(&bytes).map_err(|_| RunnerError::CanonicalJson)?))
}

pub fn consume_session_nonce(store: &LocalStore, nonce: &str, decision_digest: &str) -> Result<(), RunnerError> {
    store.consume_trusted_nonce(nonce, decision_digest)
}
