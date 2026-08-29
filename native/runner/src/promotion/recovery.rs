use crate::config::{sha256_digest_tagged, timestamp_now};
use crate::local_store::LocalStore;
use crate::promotion::journal::{
    drop_lease, get_cas_object, list_nonterminal, list_receipted_held_leases, load_apply_context, load_entries,
    load_entry_meta, set_entry_state, set_journal_state, set_workspace_recovery, workspace_root_path, JournalRow,
};
use crate::promotion::{rollback_applied, workspace_snapshot_root, EntryKind, PromotionError};
use crate::snapshot::manifest::sign_envelope;
use crate::windows::replace::{
    apply_captured_metadata, atomic_rename, atomic_replace, captured_from_json, content_digest, delete_path, fsync_path,
    in_parent_create_temp, read_bytes, staging_dir, write_staging_file,
};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn reconcile_all(store: &LocalStore) -> Result<(), PromotionError> {
    let journals = list_nonterminal(store)?;
    for journal in journals {
        reconcile_journal(store, &journal)?;
    }
    release_receipted_leases(store)?;
    Ok(())
}

fn release_receipted_leases(store: &LocalStore) -> Result<(), PromotionError> {
    for (workspace_id, state) in list_receipted_held_leases(store)? {
        let recovery = if state == "MANUAL_RECOVERY_REQUIRED" {
            "MANUAL_RECOVERY_REQUIRED"
        } else {
            "READY"
        };
        drop_lease(store, &workspace_id, recovery)?;
    }
    Ok(())
}

fn reconcile_journal(store: &LocalStore, journal: &JournalRow) -> Result<(), PromotionError> {
    let Some(root_text) = workspace_root_path(store, &journal.workspace_id)? else {
        return terminal_stale(store, journal, &journal.base_snapshot_root_digest);
    };
    let root = PathBuf::from(&root_text);
    if !root.exists() {
        return terminal_stale(store, journal, &journal.base_snapshot_root_digest);
    }
    match journal.state.as_str() {
        "PREPARING" => terminal_stale(store, journal, &journal.base_snapshot_root_digest),
        "PREPARED" | "COMMITTING" => recover_committing(store, journal, &root),
        "VERIFYING" => recover_verifying(store, journal, &root),
        "ROLLING_BACK" => recover_rollback(store, journal, &root),
        _ => Ok(()),
    }
}

fn recover_committing(store: &LocalStore, journal: &JournalRow, root: &Path) -> Result<(), PromotionError> {
    let entries = load_entries(store, &journal.journal_id)?;
    if entries.iter().any(|entry| classify_current(root, entry) == EntryProgress::Foreign) {
        return terminal_manual(store, journal, root);
    }
    if let Err(err) = roll_forward(store, journal, root, &entries) {
        if matches!(err, PromotionError::Protocol("external-conflict")) {
            return terminal_manual(store, journal, root);
        }
        return recover_rollback(store, journal, root);
    }
    recover_verifying(store, journal, root)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryProgress {
    After,
    Pending,
    Foreign,
}

fn classify_current(root: &Path, entry: &crate::promotion::journal::EntryRow) -> EntryProgress {
    if entry.entry_state == "APPLIED" {
        return EntryProgress::After;
    }
    let dest = join_rel(root, &entry.relative_path);
    let exists = dest.exists();
    let current = if exists {
        read_bytes(&dest).ok().map(|b| content_digest(&b))
    } else {
        None
    };
    match EntryKind::parse(&entry.operation_kind) {
        Ok(EntryKind::Delete) => {
            if current.is_none() {
                EntryProgress::After
            } else if current == entry.expected_before_digest {
                EntryProgress::Pending
            } else {
                EntryProgress::Foreign
            }
        }
        Ok(EntryKind::Create) => {
            if current == entry.expected_after_digest {
                EntryProgress::After
            } else if !exists {
                EntryProgress::Pending
            } else {
                EntryProgress::Foreign
            }
        }
        Ok(EntryKind::Replace) => {
            if current == entry.expected_after_digest {
                EntryProgress::After
            } else if current == entry.expected_before_digest {
                EntryProgress::Pending
            } else {
                EntryProgress::Foreign
            }
        }
        Err(_) => EntryProgress::Foreign,
    }
}

fn recover_verifying(store: &LocalStore, journal: &JournalRow, root: &Path) -> Result<(), PromotionError> {
    let entries = load_entries(store, &journal.journal_id)?;
    if entries.iter().all(|entry| classify_current(root, entry) == EntryProgress::After) {
        let snapshot = workspace_snapshot_root(root, &journal.workspace_id)?;
        if snapshot == journal.expected_result_root_digest {
            return terminal_committed(store, journal, root);
        }
        return rollback_mismatched_snapshot(store, journal, root, &snapshot);
    }
    match rollback_applied(store, root, &journal.journal_id) {
        Ok(()) => terminal_rolled_back(store, journal, root),
        Err(PromotionError::Protocol("external-conflict")) => terminal_manual(store, journal, root),
        Err(err) => Err(err),
    }
}

fn rollback_mismatched_snapshot(
    store: &LocalStore,
    journal: &JournalRow,
    root: &Path,
    observed: &str,
) -> Result<(), PromotionError> {
    match rollback_applied(store, root, &journal.journal_id) {
        Ok(()) => terminal_stale(store, journal, observed),
        Err(PromotionError::Protocol("external-conflict")) => terminal_manual(store, journal, root),
        Err(err) => Err(err),
    }
}

fn recover_rollback(store: &LocalStore, journal: &JournalRow, root: &Path) -> Result<(), PromotionError> {
    set_journal_state(store, &journal.journal_id, "ROLLING_BACK", None)?;
    match rollback_applied(store, root, &journal.journal_id) {
        Ok(()) => terminal_rolled_back(store, journal, root),
        Err(PromotionError::Protocol("external-conflict")) => terminal_manual(store, journal, root),
        Err(err) => Err(err),
    }
}

fn restore_stored_meta(
    store: &LocalStore,
    journal_id: &str,
    sequence: i64,
    dest: &Path,
) -> Result<(), PromotionError> {
    if let Some(meta_json) = load_entry_meta(store, journal_id, sequence)?
        && let Ok(meta) = captured_from_json(&meta_json)
    {
        apply_captured_metadata(dest, &meta)?;
    }
    Ok(())
}

fn roll_forward(
    store: &LocalStore,
    journal: &JournalRow,
    root: &Path,
    entries: &[crate::promotion::journal::EntryRow],
) -> Result<(), PromotionError> {
    let stage = staging_dir(root, &journal.workspace_id);
    std::fs::create_dir_all(&stage)?;
    set_journal_state(store, &journal.journal_id, "COMMITTING", None)?;
    for entry in entries {
        if entry.entry_state == "APPLIED" || entry.entry_state == "ROLLED_BACK" {
            continue;
        }
        let dest = join_rel(root, &entry.relative_path);
        match classify_current(root, entry) {
            EntryProgress::After => {
                restore_stored_meta(store, &journal.journal_id, entry.sequence, &dest)?;
                set_entry_state(store, &journal.journal_id, entry.sequence, "APPLIED")?;
                continue;
            }
            EntryProgress::Foreign => return Err(PromotionError::Protocol("external-conflict")),
            EntryProgress::Pending => {}
        }
        let kind = EntryKind::parse(&entry.operation_kind)?;
        match kind {
            EntryKind::Replace => {
                let digest = entry
                    .expected_after_digest
                    .as_deref()
                    .ok_or(PromotionError::Protocol("missing after digest"))?;
                let bytes = get_cas_object(store, digest)?;
                let staged = stage.join(format!("{}.staged", entry.sequence));
                write_staging_file(&staged, &bytes)?;
                restore_stored_meta(store, &journal.journal_id, entry.sequence, &staged)?;
                atomic_replace(&staged, &dest)?;
            }
            EntryKind::Create => {
                let digest = entry
                    .expected_after_digest
                    .as_deref()
                    .ok_or(PromotionError::Protocol("missing after digest"))?;
                let bytes = get_cas_object(store, digest)?;
                let tmp = in_parent_create_temp(&dest);
                write_staging_file(&tmp, &bytes)?;
                fsync_path(&tmp)?;
                atomic_rename(&tmp, &dest)?;
            }
            EntryKind::Delete => {
                if dest.exists() {
                    delete_path(&dest)?;
                }
            }
        }
        set_entry_state(store, &journal.journal_id, entry.sequence, "APPLIED")?;
    }
    set_journal_state(store, &journal.journal_id, "VERIFYING", None)?;
    Ok(())
}

fn join_rel(root: &Path, relative: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
    }
    path
}

fn signing(store: &LocalStore) -> Result<SigningKey, PromotionError> {
    let secret = store.load_ed25519_secret()?;
    Ok(SigningKey::from_bytes(&secret))
}

fn persist_terminal(
    store: &LocalStore,
    journal: &JournalRow,
    state: &str,
    receipt: &Value,
    recovery_state: &str,
) -> Result<(), PromotionError> {
    let key = signing(store)?;
    let signed_at = timestamp_now()?;
    let (key_id, cert) = match load_apply_context(store, &journal.journal_id)? {
        Some((_, key_id, cert)) => (key_id, cert),
        None => (
            "runner-sign-1".to_string(),
            journal.approval_object_digest.clone(),
        ),
    };
    let envelope = sign_envelope("ApplyReceipt", receipt, &key, &key_id, &cert, &signed_at)?;
    let digest = sha256_digest_tagged(
        &serde_json::to_vec(&envelope).map_err(|_| PromotionError::Protocol("receipt json"))?,
    );
    set_journal_state(store, &journal.journal_id, state, Some(&digest))?;
    drop_lease(store, &journal.workspace_id, recovery_state)?;
    Ok(())
}

fn receipt_affected(store: &LocalStore, journal: &JournalRow, root: &Path) -> Vec<Value> {
    let Ok(entries) = load_entries(store, &journal.journal_id) else {
        return Vec::new();
    };
    let mut affected = Vec::new();
    for entry in entries {
        let dest = join_rel(root, &entry.relative_path);
        let observed = if dest.exists() {
            read_bytes(&dest).ok().map(|b| content_digest(&b))
        } else {
            None
        };
        affected.push(json!({
            "path": entry.relative_path,
            "beforeDigest": entry.expected_before_digest,
            "expectedAfterDigest": entry.expected_after_digest,
            "observedAfterDigest": observed
        }));
    }
    affected
}

fn approval_id_for(store: &LocalStore, journal: &JournalRow) -> String {
    load_apply_context(store, &journal.journal_id)
        .ok()
        .flatten()
        .map(|(approval, _, _)| approval)
        .unwrap_or_else(|| journal.approval_object_digest.clone())
}

fn base_receipt(store: &LocalStore, journal: &JournalRow, root: &Path, outcome: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "runId": journal.run_id,
        "approvalId": approval_id_for(store, journal),
        "workspaceId": journal.workspace_id,
        "candidateManifestObjectDigest": journal.candidate_manifest_object_digest,
        "baseSnapshotRootDigest": journal.base_snapshot_root_digest,
        "changeSetObjectDigest": journal.change_set_object_digest,
        "journalObjectDigest": sha256_digest_tagged(journal.journal_id.as_bytes()),
        "promotionMode": journal.promotion_mode,
        "affectedPaths": receipt_affected(store, journal, root),
        "completedAt": timestamp_now().unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string()),
        "outcome": outcome
    })
}

fn terminal_stale(store: &LocalStore, journal: &JournalRow, observed: &str) -> Result<(), PromotionError> {
    let root = workspace_root_path(store, &journal.workspace_id)?
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut receipt = base_receipt(store, journal, &root, "STALE");
    if let Some(obj) = receipt.as_object_mut() {
        obj.insert(
            "observedWorkspaceRootDigest".into(),
            Value::String(observed.to_string()),
        );
    }
    persist_terminal(store, journal, "STALE", &receipt, "READY")
}

fn terminal_committed(store: &LocalStore, journal: &JournalRow, root: &Path) -> Result<(), PromotionError> {
    let snapshot = workspace_snapshot_root(root, &journal.workspace_id)?;
    if snapshot != journal.expected_result_root_digest {
        return rollback_mismatched_snapshot(store, journal, root, &snapshot);
    }
    let mut receipt = base_receipt(store, journal, root, "COMMITTED");
    if let Some(obj) = receipt.as_object_mut() {
        obj.insert("resultingRootDigest".into(), Value::String(snapshot));
        obj.insert("visibilityGuarantee".into(), Value::String("ENTRY_LEVEL".into()));
    }
    persist_terminal(store, journal, "COMMITTED", &receipt, "READY")
}

fn terminal_rolled_back(store: &LocalStore, journal: &JournalRow, root: &Path) -> Result<(), PromotionError> {
    let snapshot = workspace_snapshot_root(root, &journal.workspace_id)
        .unwrap_or_else(|_| journal.base_snapshot_root_digest.clone());
    let mut receipt = base_receipt(store, journal, root, "ROLLED_BACK");
    if let Some(obj) = receipt.as_object_mut() {
        obj.insert("restoredRootDigest".into(), Value::String(snapshot));
    }
    persist_terminal(store, journal, "ROLLED_BACK", &receipt, "READY")
}

fn terminal_manual(store: &LocalStore, journal: &JournalRow, root: &Path) -> Result<(), PromotionError> {
    let snapshot = workspace_snapshot_root(root, &journal.workspace_id)
        .unwrap_or_else(|_| journal.base_snapshot_root_digest.clone());
    let affected = receipt_affected(store, journal, root);
    let evidence = sha256_digest_tagged(
        &serde_json::to_vec(&json!({ "paths": affected })).map_err(|_| PromotionError::Protocol("evidence json"))?,
    );
    let mut receipt = base_receipt(store, journal, root, "MANUAL_RECOVERY_REQUIRED");
    if let Some(obj) = receipt.as_object_mut() {
        obj.insert("observedWorkspaceRootDigest".into(), Value::String(snapshot));
        obj.insert("recoveryEvidenceObjectDigest".into(), Value::String(evidence));
    }
    persist_terminal(store, journal, "MANUAL_RECOVERY_REQUIRED", &receipt, "MANUAL_RECOVERY_REQUIRED")?;
    set_workspace_recovery(store, &journal.workspace_id, "MANUAL_RECOVERY_REQUIRED")?;
    Ok(())
}
