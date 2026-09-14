use crate::config::{RunnerError, sha256_digest_tagged, timestamp_now};
use crate::local_store::LocalStore;
use crate::snapshot::manifest::{envelope_object_digest, sign_envelope, verify_envelope};
use crate::windows::handles::{
    FileHandle, inspect_handle, open_deny_write_handle, open_reparse_handle, volume_identity_string,
};
use crate::windows::paths::classify_snapshot_root;
use crate::windows::presence::{PresenceError, request_platform_assertion};
use crate::windows::replace::{
    CapturedMetadata, ReplaceError, apply_captured_metadata, atomic_rename, atomic_replace,
    capture_held, captured_from_json, captured_to_json, content_digest, delete_path,
    fsync_directory, fsync_path, in_parent_create_temp, probe_atomic_root_switch, read_bytes,
    same_volume, staging_dir, write_staging_file,
};
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub mod journal;
pub mod recovery;
mod tree;

pub(crate) use tree::join_rel;
pub use tree::{
    candidate_tree_digest, current_file_digest, lease_state, read_workspace_files,
    security_digest_of, streams_of, workspace_snapshot_root,
};

use journal::{
    EntryRow, begin_journal, consume_grant, consume_session_nonce, drop_lease, get_cas_object,
    insert_entry, journal_plan_digest, load_entries, load_entry_meta, put_cas_object,
    set_entry_state, set_journal_state, store_apply_context, store_entry_meta,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checkpoint {
    Prepared,
    Committing,
    AfterFsBeforeSql(u32),
    AfterEntry(u32),
    Verifying,
    RollingBack,
    CommittedBeforeReceipt,
    ReceiptBeforeLeaseDrop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Replace,
    Create,
    Delete,
}

impl EntryKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Replace => "REPLACE",
            Self::Create => "CREATE",
            Self::Delete => "DELETE",
        }
    }

    fn parse(value: &str) -> Result<Self, PromotionError> {
        match value {
            "REPLACE" => Ok(Self::Replace),
            "CREATE" => Ok(Self::Create),
            "DELETE" => Ok(Self::Delete),
            _ => Err(PromotionError::Protocol("unknown promotion entry kind")),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PromotionEntry {
    pub kind: EntryKind,
    pub relative_path: String,
    pub after_bytes: Option<Vec<u8>>,
}

pub type UserPresenceFn = fn(&str) -> Result<(), PresenceError>;

pub struct ApplyRequest<'a> {
    pub store: &'a LocalStore,
    pub workspace_id: &'a str,
    pub project_id: &'a str,
    pub workspace_root: &'a Path,
    pub run_id: &'a str,
    pub approval_id: &'a str,
    pub grant_envelope: Value,
    pub subject_envelope: Value,
    pub decision_envelope: Value,
    pub grant_verifying_key: &'a VerifyingKey,
    pub promotion_mode: &'a str,
    pub user_presence: Option<UserPresenceFn>,
    pub candidate_manifest_object_digest: &'a str,
    pub change_set_object_digest: &'a str,
    pub base_snapshot_root_digest: &'a str,
    pub expected_result_root_digest: &'a str,
    pub entries: Vec<PromotionEntry>,
    pub signing_key: &'a SigningKey,
    pub signature_key_id: &'a str,
    pub signer_certificate_object_digest: &'a str,
    pub now: &'a str,
    pub crash_after: Option<Checkpoint>,
    pub fail_at_entry: Option<u32>,
    pub mutate_after_prepared: Option<&'a dyn Fn(&Path)>,
    pub rewrite_after_entry: Option<(u32, &'a [u8])>,
}

#[derive(Debug, Clone)]
pub struct ApplyOutcome {
    pub receipt: Value,
    pub envelope: Value,
    pub journal_id: String,
    pub lease_held: bool,
}

#[derive(Debug)]
pub enum PromotionError {
    Stale,
    Denied,
    Expired,
    Replay,
    GrantConsumed,
    SubjectMismatch,
    RootSwapUnproven,
    Metadata(&'static str),
    InjectedCrash(Checkpoint),
    Protocol(&'static str),
    Runner(RunnerError),
    Replace(ReplaceError),
    Io(std::io::Error),
    Presence(&'static str),
}

impl std::fmt::Display for PromotionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stale => f.write_str("STALE"),
            Self::Denied => f.write_str("denied"),
            Self::Expired => f.write_str("expired"),
            Self::Replay => f.write_str("nonce-replay"),
            Self::GrantConsumed => f.write_str("grant-consumed"),
            Self::SubjectMismatch => f.write_str("subject-mismatch"),
            Self::RootSwapUnproven => f.write_str("ROOT_SWAP unproven"),
            Self::Metadata(msg) => write!(f, "metadata: {msg}"),
            Self::InjectedCrash(cp) => write!(f, "injected crash {cp:?}"),
            Self::Protocol(msg) => f.write_str(msg),
            Self::Runner(err) => write!(f, "{err}"),
            Self::Replace(err) => write!(f, "{err}"),
            Self::Io(err) => write!(f, "io: {err}"),
            Self::Presence(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for PromotionError {}

impl From<RunnerError> for PromotionError {
    fn from(value: RunnerError) -> Self {
        Self::Runner(value)
    }
}

impl From<ReplaceError> for PromotionError {
    fn from(value: ReplaceError) -> Self {
        Self::Replace(value)
    }
}

impl From<std::io::Error> for PromotionError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<PresenceError> for PromotionError {
    fn from(value: PresenceError) -> Self {
        match value {
            PresenceError::Absent => Self::Presence("authenticator-absent"),
            PresenceError::Mismatch => Self::Presence("presence-mismatch"),
        }
    }
}

fn maybe_crash(req: &ApplyRequest<'_>, checkpoint: Checkpoint) -> Result<(), PromotionError> {
    if req.crash_after.as_ref() == Some(&checkpoint) {
        Err(PromotionError::InjectedCrash(checkpoint))
    } else {
        Ok(())
    }
}

fn verify_grant(req: &ApplyRequest<'_>) -> Result<String, PromotionError> {
    if req.grant_envelope.get("schemaName").and_then(Value::as_str) != Some("ApprovalGrant") {
        return Err(PromotionError::Protocol("grant schema"));
    }
    if req
        .subject_envelope
        .get("schemaName")
        .and_then(Value::as_str)
        != Some("ApprovalSubject")
    {
        return Err(PromotionError::Protocol("subject schema"));
    }
    if req
        .decision_envelope
        .get("schemaName")
        .and_then(Value::as_str)
        != Some("ApprovalDecision")
    {
        return Err(PromotionError::Protocol("decision schema"));
    }
    verify_envelope(
        &req.grant_envelope,
        req.grant_verifying_key,
        req.signature_key_id,
    )
    .map_err(|_| PromotionError::Protocol("grant signature"))?;
    verify_envelope(
        &req.subject_envelope,
        req.grant_verifying_key,
        req.signature_key_id,
    )
    .map_err(|_| PromotionError::Protocol("subject signature"))?;
    verify_envelope(
        &req.decision_envelope,
        req.grant_verifying_key,
        req.signature_key_id,
    )
    .map_err(|_| PromotionError::Protocol("decision signature"))?;
    let grant = req
        .grant_envelope
        .get("payload")
        .ok_or(PromotionError::Protocol("grant payload"))?;
    let subject = req
        .subject_envelope
        .get("payload")
        .ok_or(PromotionError::Protocol("subject payload"))?;
    let decision = req
        .decision_envelope
        .get("payload")
        .ok_or(PromotionError::Protocol("decision payload"))?;
    let subject_digest =
        envelope_object_digest(&req.subject_envelope).map_err(PromotionError::from)?;
    let decision_digest =
        envelope_object_digest(&req.decision_envelope).map_err(PromotionError::from)?;
    if grant.get("subjectObjectDigest").and_then(Value::as_str) != Some(subject_digest.as_str()) {
        return Err(PromotionError::SubjectMismatch);
    }
    if grant
        .get("approvalDecisionObjectDigest")
        .and_then(Value::as_str)
        != Some(decision_digest.as_str())
    {
        return Err(PromotionError::SubjectMismatch);
    }
    let challenge = grant
        .get("challengeObjectDigest")
        .and_then(Value::as_str)
        .ok_or(PromotionError::Protocol("grant challenge"))?;
    if decision
        .get("challengeObjectDigest")
        .and_then(Value::as_str)
        != Some(challenge)
    {
        return Err(PromotionError::SubjectMismatch);
    }
    match req.user_presence {
        Some(prove) => prove(challenge).map_err(PromotionError::from)?,
        None => request_platform_assertion(challenge).map_err(PromotionError::from)?,
    }
    let action = grant
        .get("action")
        .and_then(Value::as_str)
        .ok_or(PromotionError::Protocol("grant action"))?;
    let expires = grant
        .get("expiresAt")
        .and_then(Value::as_str)
        .ok_or(PromotionError::Protocol("grant expiry"))?;
    let kind = subject
        .get("kind")
        .and_then(Value::as_str)
        .ok_or(PromotionError::Protocol("subject kind"))?;
    let mode = subject
        .get("promotionMode")
        .and_then(Value::as_str)
        .ok_or(PromotionError::Protocol("promotion mode"))?;
    if action != "workspace-promotion" || kind != "workspace-promotion" {
        return Err(PromotionError::SubjectMismatch);
    }
    if expires <= req.now {
        return Err(PromotionError::Expired);
    }
    if mode != req.promotion_mode {
        return Err(PromotionError::SubjectMismatch);
    }
    if mode != "ENTRY_JOURNALED" && mode != "ROOT_SWAP" {
        return Err(PromotionError::SubjectMismatch);
    }
    if mode == "ROOT_SWAP" && !probe_atomic_root_switch() {
        return Err(PromotionError::RootSwapUnproven);
    }
    let nonce = decision
        .get("nonce")
        .and_then(Value::as_str)
        .ok_or(PromotionError::Protocol("decision nonce"))?;
    let digest = envelope_object_digest(&req.grant_envelope).map_err(PromotionError::from)?;
    consume_session_nonce(req.store, nonce, &decision_digest).map_err(|err| match err {
        RunnerError::Conflict | RunnerError::NotFound => PromotionError::Replay,
        other => PromotionError::Runner(other),
    })?;
    consume_grant(req.store, &digest).map_err(|err| match err {
        RunnerError::Conflict => PromotionError::GrantConsumed,
        other => PromotionError::Runner(other),
    })?;
    Ok(digest)
}

pub fn apply_promotion(req: &ApplyRequest<'_>) -> Result<ApplyOutcome, PromotionError> {
    let grant_digest = verify_grant(req)?;
    let classified = classify_snapshot_root(&req.workspace_root.to_string_lossy())
        .map_err(|_| PromotionError::Protocol("workspace path"))?;
    let root_handle = open_reparse_handle(&classified.display)
        .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
    let root_opened = inspect_handle(&root_handle)
        .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
    let journal_id = begin_journal(
        req.store,
        req.workspace_id,
        req.project_id,
        &classified.display.to_string_lossy(),
        &volume_identity_string(&root_opened.identity),
        &root_opened.identity.encoded(),
        req.run_id,
        &grant_digest,
        req.candidate_manifest_object_digest,
        req.change_set_object_digest,
        req.base_snapshot_root_digest,
        req.expected_result_root_digest,
        req.promotion_mode,
    )?;
    store_apply_context(
        req.store,
        &journal_id,
        req.approval_id,
        req.signature_key_id,
        req.signer_certificate_object_digest,
    )?;
    let stage = staging_dir(&classified.display, req.workspace_id);
    std::fs::create_dir_all(&stage)?;
    if !same_volume(&classified.display, &stage)? {
        return Err(PromotionError::Replace(ReplaceError::Volume));
    }
    let mut prepared = match prepare_entries(req, &classified.display, &stage, &journal_id) {
        Ok(rows) => rows,
        Err(err) => {
            let _ = finish_stale(req, &journal_id, None);
            return Err(err);
        }
    };
    journal::set_journal_state(req.store, &journal_id, "PREPARED", None)?;
    fsync_directory(&stage)?;
    maybe_crash(req, Checkpoint::Prepared)?;
    if let Some(mutate) = req.mutate_after_prepared {
        for entry in &mut prepared {
            entry.handle = None;
        }
        mutate(&classified.display);
    }
    for entry in &prepared {
        if reccheck_precondition(&classified.display, entry).is_err() {
            return finish_stale(req, &journal_id, None);
        }
    }
    journal::set_journal_state(req.store, &journal_id, "COMMITTING", None)?;
    maybe_crash(req, Checkpoint::Committing)?;
    match commit_entries(req, &classified.display, &stage, &journal_id, &mut prepared) {
        Ok(()) => {}
        Err(PromotionError::InjectedCrash(cp)) => return Err(PromotionError::InjectedCrash(cp)),
        Err(_) => match rollback_journal(req.store, &classified.display, &journal_id, req) {
            Err(PromotionError::InjectedCrash(cp)) => {
                return Err(PromotionError::InjectedCrash(cp));
            }
            Err(PromotionError::Protocol("external-conflict")) => {
                return finish_manual(req, &journal_id);
            }
            Ok(()) => {
                return finish_rolled_back(req, &journal_id);
            }
            Err(_) => return finish_stale(req, &journal_id, None),
        },
    }
    journal::set_journal_state(req.store, &journal_id, "VERIFYING", None)?;
    maybe_crash(req, Checkpoint::Verifying)?;
    let (snapshot_digest, affected) = match verify_result(req, &classified.display, &journal_id) {
        Ok(value) => value,
        Err(PromotionError::InjectedCrash(cp)) => return Err(PromotionError::InjectedCrash(cp)),
        Err(_) => match rollback_journal(req.store, &classified.display, &journal_id, req) {
            Err(PromotionError::InjectedCrash(cp)) => {
                return Err(PromotionError::InjectedCrash(cp));
            }
            Err(PromotionError::Protocol("external-conflict")) => {
                return finish_manual(req, &journal_id);
            }
            Ok(()) => return finish_stale(req, &journal_id, None),
            Err(_) => return finish_stale(req, &journal_id, None),
        },
    };
    maybe_crash(req, Checkpoint::CommittedBeforeReceipt)?;
    let receipt = committed_receipt(req, &journal_id, &snapshot_digest, &affected)?;
    let envelope = persist_receipt(req, &journal_id, "COMMITTED", &receipt)?;
    maybe_crash(req, Checkpoint::ReceiptBeforeLeaseDrop)?;
    drop_lease(req.store, req.workspace_id, "READY")?;
    let _ = std::fs::remove_dir_all(&stage);
    Ok(ApplyOutcome {
        receipt,
        envelope,
        journal_id,
        lease_held: false,
    })
}

fn prepare_entries(
    req: &ApplyRequest<'_>,
    root: &Path,
    stage: &Path,
    journal_id: &str,
) -> Result<Vec<PreparedEntry>, PromotionError> {
    let mut prepared = Vec::new();
    for (index, entry) in req.entries.iter().enumerate() {
        let dest = join_rel(root, &entry.relative_path);
        let exists = dest.exists();
        let (before, meta, rollback, handle) = if exists {
            let (meta, handle) =
                capture_held(&dest).map_err(|_| PromotionError::Metadata("capture existing"))?;
            if meta.is_directory {
                return Err(PromotionError::Metadata("directory replace unsupported"));
            }
            let bytes = read_bytes(&dest)?;
            let digest = content_digest(&bytes);
            let rollback = put_cas_object(req.store, &bytes)?;
            (Some(digest), Some(meta), Some(rollback), Some(handle))
        } else {
            (None, None, None, None)
        };
        match entry.kind {
            EntryKind::Replace if before.is_none() => return Err(PromotionError::Stale),
            EntryKind::Create if before.is_some() => return Err(PromotionError::Stale),
            EntryKind::Delete if before.is_none() => return Err(PromotionError::Stale),
            _ => {}
        }
        let after = match entry.kind {
            EntryKind::Delete => None,
            EntryKind::Replace => {
                let bytes = entry
                    .after_bytes
                    .as_ref()
                    .ok_or(PromotionError::Protocol("missing after bytes"))?;
                let digest = content_digest(bytes);
                put_cas_object(req.store, bytes)?;
                let staged = stage.join(format!("{index}.staged"));
                write_staging_file(&staged, bytes)?;
                if let Some(meta) = &meta {
                    apply_captured_metadata(&staged, meta)?;
                }
                Some(digest)
            }
            EntryKind::Create => {
                let bytes = entry
                    .after_bytes
                    .as_ref()
                    .ok_or(PromotionError::Protocol("missing after bytes"))?;
                let digest = content_digest(bytes);
                put_cas_object(req.store, bytes)?;
                let tmp = in_parent_create_temp(&dest);
                write_staging_file(&tmp, bytes)?;
                fsync_path(&tmp)?;
                Some(digest)
            }
        };
        insert_entry(
            req.store,
            journal_id,
            index as i64,
            entry.kind.as_str(),
            &entry.relative_path,
            before.as_deref(),
            after.as_deref(),
            rollback.as_deref(),
            "STAGED",
        )?;
        if let Some(meta) = &meta {
            store_entry_meta(req.store, journal_id, index as i64, &captured_to_json(meta))?;
        }
        prepared.push(PreparedEntry {
            sequence: index as u32,
            kind: entry.kind,
            relative_path: entry.relative_path.clone(),
            before,
            meta,
            handle,
            create_tmp: if entry.kind == EntryKind::Create {
                Some(in_parent_create_temp(&dest))
            } else {
                None
            },
        });
    }
    Ok(prepared)
}

struct PreparedEntry {
    sequence: u32,
    kind: EntryKind,
    relative_path: String,
    before: Option<String>,
    meta: Option<CapturedMetadata>,
    handle: Option<FileHandle>,
    create_tmp: Option<PathBuf>,
}

fn commit_entries(
    req: &ApplyRequest<'_>,
    root: &Path,
    stage: &Path,
    journal_id: &str,
    prepared: &mut [PreparedEntry],
) -> Result<(), PromotionError> {
    for entry in prepared.iter_mut() {
        if req.fail_at_entry == Some(entry.sequence) {
            set_journal_state(req.store, journal_id, "ROLLING_BACK", None)?;
            maybe_crash(req, Checkpoint::RollingBack)?;
            return Err(PromotionError::Stale);
        }
        let dest = join_rel(root, &entry.relative_path);
        reccheck_precondition(root, entry)?;
        drop(entry.handle.take());
        match entry.kind {
            EntryKind::Replace => {
                let staged = stage.join(format!("{}.staged", entry.sequence));
                atomic_replace(&staged, &dest)?;
            }
            EntryKind::Create => {
                let tmp = entry
                    .create_tmp
                    .take()
                    .ok_or(PromotionError::Protocol("create temp"))?;
                atomic_rename(&tmp, &dest)?;
            }
            EntryKind::Delete => delete_path(&dest)?,
        }
        maybe_crash(req, Checkpoint::AfterFsBeforeSql(entry.sequence))?;
        set_entry_state(req.store, journal_id, entry.sequence as i64, "APPLIED")?;
        if let Some((seq, bytes)) = req.rewrite_after_entry
            && seq == entry.sequence
        {
            std::fs::write(&dest, bytes)?;
        }
        maybe_crash(req, Checkpoint::AfterEntry(entry.sequence))?;
    }
    Ok(())
}

fn reccheck_precondition(root: &Path, entry: &PreparedEntry) -> Result<(), PromotionError> {
    let dest = join_rel(root, &entry.relative_path);
    let exists = dest.exists();
    match entry.kind {
        EntryKind::Create => {
            if exists {
                return Err(PromotionError::Stale);
            }
        }
        EntryKind::Replace | EntryKind::Delete => {
            if !exists {
                return Err(PromotionError::Stale);
            }
            let Some(meta) = &entry.meta else {
                return Err(PromotionError::Metadata("missing capture"));
            };
            let owned =
                if entry.handle.is_none() {
                    Some(open_deny_write_handle(&dest).map_err(|err| {
                        PromotionError::Io(std::io::Error::other(err.to_string()))
                    })?)
                } else {
                    None
                };
            let opened = if let Some(handle) = &entry.handle {
                inspect_handle(handle)
                    .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?
            } else {
                inspect_handle(owned.as_ref().ok_or(PromotionError::Protocol("handle"))?)
                    .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?
            };
            if opened.identity.encoded() != meta.identity
                || opened.security_descriptor_digest != meta.security_digest
                || opened.reparse_tag != meta.reparse_tag
                || opened.is_directory != meta.is_directory
            {
                return Err(PromotionError::Stale);
            }
            if streams_of(&dest)? != meta.streams || meta.git_mode != "100644" {
                return Err(PromotionError::Stale);
            }
            let bytes = read_bytes(&dest)?;
            if Some(content_digest(&bytes)) != entry.before {
                return Err(PromotionError::Stale);
            }
        }
    }
    Ok(())
}

pub(crate) fn rollback_journal(
    store: &LocalStore,
    root: &Path,
    journal_id: &str,
    req: &ApplyRequest<'_>,
) -> Result<(), PromotionError> {
    set_journal_state(store, journal_id, "ROLLING_BACK", None)?;
    maybe_crash(req, Checkpoint::RollingBack)?;
    rollback_applied(store, root, journal_id)?;
    Ok(())
}

pub(crate) fn rollback_applied(
    store: &LocalStore,
    root: &Path,
    journal_id: &str,
) -> Result<(), PromotionError> {
    let mut entries = load_entries(store, journal_id)?;
    entries.sort_by_key(|e| e.sequence);
    entries.reverse();
    let mut manual = Vec::new();
    for entry in entries {
        if entry.entry_state == "ROLLED_BACK" {
            continue;
        }
        match rollback_one(store, root, journal_id, &entry) {
            Ok(()) => set_entry_state(store, journal_id, entry.sequence, "ROLLED_BACK")?,
            Err(PromotionError::Protocol("external-conflict")) => {
                set_entry_state(store, journal_id, entry.sequence, "EXTERNAL_CONFLICT")?;
                manual.push(entry.relative_path);
            }
            Err(err) => return Err(err),
        }
    }
    if !manual.is_empty() {
        return Err(PromotionError::Protocol("external-conflict"));
    }
    Ok(())
}

fn rollback_one(
    store: &LocalStore,
    root: &Path,
    journal_id: &str,
    entry: &EntryRow,
) -> Result<(), PromotionError> {
    let dest = join_rel(root, &entry.relative_path);
    let current = if dest.exists() {
        Some(content_digest(&read_bytes(&dest)?))
    } else {
        None
    };
    if current == entry.expected_before_digest {
        return Ok(());
    }
    if current != entry.expected_after_digest {
        return Err(PromotionError::Protocol("external-conflict"));
    }
    let kind = EntryKind::parse(&entry.operation_kind)?;
    match kind {
        EntryKind::Create => {
            if dest.exists() {
                delete_path(&dest)?;
            }
            let tmp = in_parent_create_temp(&dest);
            if tmp.exists() {
                delete_path(&tmp)?;
            }
        }
        EntryKind::Replace | EntryKind::Delete => {
            let digest = entry
                .rollback_object_digest
                .as_deref()
                .ok_or(PromotionError::Protocol("missing rollback object"))?;
            let bytes = get_cas_object(store, digest)?;
            let tmp = dest.with_extension("pi-hec-rollback");
            write_staging_file(&tmp, &bytes)?;
            if dest.exists() {
                atomic_replace(&tmp, &dest)?;
            } else {
                atomic_rename(&tmp, &dest)?;
            }
            if let Some(meta_json) = load_entry_meta(store, journal_id, entry.sequence)?
                && let Ok(meta) = captured_from_json(&meta_json)
            {
                apply_captured_metadata(&dest, &meta)?;
            }
        }
    }
    Ok(())
}

fn verify_result(
    req: &ApplyRequest<'_>,
    root: &Path,
    journal_id: &str,
) -> Result<(String, Vec<Value>), PromotionError> {
    let snapshot = workspace_snapshot_root(root, req.workspace_id)?;
    let journal_entries = load_entries(req.store, journal_id)?;
    let mut affected = Vec::new();
    let mut matched = true;
    for entry in &req.entries {
        let dest = join_rel(root, &entry.relative_path);
        let observed = if dest.exists() {
            Some(content_digest(&read_bytes(&dest)?))
        } else {
            None
        };
        let planned = journal_entries
            .iter()
            .find(|row| row.relative_path == entry.relative_path);
        let expected = match entry.kind {
            EntryKind::Delete => None,
            _ => entry.after_bytes.as_ref().map(|b| content_digest(b)),
        };
        if observed != expected {
            matched = false;
        }
        affected.push(json!({
            "path": entry.relative_path,
            "beforeDigest": planned.and_then(|row| row.expected_before_digest.clone()),
            "expectedAfterDigest": expected,
            "observedAfterDigest": observed
        }));
    }
    if !matched {
        return Err(PromotionError::Stale);
    }
    if snapshot != req.expected_result_root_digest {
        return Err(PromotionError::Stale);
    }
    Ok((snapshot, affected))
}

fn affected_paths_for(
    req: &ApplyRequest<'_>,
    journal_id: &str,
) -> Result<Vec<Value>, PromotionError> {
    let entries = load_entries(req.store, journal_id).unwrap_or_else(|_| Vec::new());
    let mut affected = Vec::new();
    for entry in entries {
        let dest = join_rel(req.workspace_root, &entry.relative_path);
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
    Ok(affected)
}

fn manual_evidence_digest(affected: &[Value]) -> String {
    match serde_json::to_vec(&json!({ "paths": affected })) {
        Ok(bytes) => sha256_digest_tagged(&bytes),
        Err(_) => sha256_digest_tagged(b"{}"),
    }
}

fn finish_stale(
    req: &ApplyRequest<'_>,
    journal_id: &str,
    observed: Option<&str>,
) -> Result<ApplyOutcome, PromotionError> {
    let observed = observed.map(str::to_string).unwrap_or_else(|| {
        workspace_snapshot_root(req.workspace_root, req.workspace_id)
            .unwrap_or_else(|_| req.base_snapshot_root_digest.to_string())
    });
    let affected = affected_paths_for(req, journal_id).unwrap_or_default();
    let receipt = json!({
        "schemaVersion": 1,
        "runId": req.run_id,
        "approvalId": req.approval_id,
        "workspaceId": req.workspace_id,
        "candidateManifestObjectDigest": req.candidate_manifest_object_digest,
        "baseSnapshotRootDigest": req.base_snapshot_root_digest,
        "changeSetObjectDigest": req.change_set_object_digest,
        "journalObjectDigest": sha256_digest_tagged(journal_id.as_bytes()),
        "promotionMode": req.promotion_mode,
        "affectedPaths": affected,
        "completedAt": req.now,
        "outcome": "STALE",
        "observedWorkspaceRootDigest": observed
    });
    let envelope = persist_receipt(req, journal_id, "STALE", &receipt)?;
    drop_lease(req.store, req.workspace_id, "READY")?;
    Ok(ApplyOutcome {
        receipt,
        envelope,
        journal_id: journal_id.to_string(),
        lease_held: false,
    })
}

fn finish_rolled_back(
    req: &ApplyRequest<'_>,
    journal_id: &str,
) -> Result<ApplyOutcome, PromotionError> {
    let observed = workspace_snapshot_root(req.workspace_root, req.workspace_id)
        .unwrap_or_else(|_| req.base_snapshot_root_digest.to_string());
    let affected = affected_paths_for(req, journal_id).unwrap_or_default();
    let receipt = json!({
        "schemaVersion": 1,
        "runId": req.run_id,
        "approvalId": req.approval_id,
        "workspaceId": req.workspace_id,
        "candidateManifestObjectDigest": req.candidate_manifest_object_digest,
        "baseSnapshotRootDigest": req.base_snapshot_root_digest,
        "changeSetObjectDigest": req.change_set_object_digest,
        "journalObjectDigest": sha256_digest_tagged(journal_id.as_bytes()),
        "promotionMode": req.promotion_mode,
        "affectedPaths": affected,
        "completedAt": req.now,
        "outcome": "ROLLED_BACK",
        "restoredRootDigest": observed
    });
    let envelope = persist_receipt(req, journal_id, "ROLLED_BACK", &receipt)?;
    drop_lease(req.store, req.workspace_id, "READY")?;
    Ok(ApplyOutcome {
        receipt,
        envelope,
        journal_id: journal_id.to_string(),
        lease_held: false,
    })
}

fn finish_manual(req: &ApplyRequest<'_>, journal_id: &str) -> Result<ApplyOutcome, PromotionError> {
    let observed = workspace_snapshot_root(req.workspace_root, req.workspace_id)
        .unwrap_or_else(|_| req.base_snapshot_root_digest.to_string());
    let affected = affected_paths_for(req, journal_id).unwrap_or_default();
    let evidence = manual_evidence_digest(&affected);
    let receipt = json!({
        "schemaVersion": 1,
        "runId": req.run_id,
        "approvalId": req.approval_id,
        "workspaceId": req.workspace_id,
        "candidateManifestObjectDigest": req.candidate_manifest_object_digest,
        "baseSnapshotRootDigest": req.base_snapshot_root_digest,
        "changeSetObjectDigest": req.change_set_object_digest,
        "journalObjectDigest": sha256_digest_tagged(journal_id.as_bytes()),
        "promotionMode": req.promotion_mode,
        "affectedPaths": affected,
        "completedAt": req.now,
        "outcome": "MANUAL_RECOVERY_REQUIRED",
        "observedWorkspaceRootDigest": observed,
        "recoveryEvidenceObjectDigest": evidence
    });
    let envelope = persist_receipt(req, journal_id, "MANUAL_RECOVERY_REQUIRED", &receipt)?;
    drop_lease(req.store, req.workspace_id, "MANUAL_RECOVERY_REQUIRED")?;
    Ok(ApplyOutcome {
        receipt,
        envelope,
        journal_id: journal_id.to_string(),
        lease_held: false,
    })
}

fn committed_receipt(
    req: &ApplyRequest<'_>,
    journal_id: &str,
    snapshot_digest: &str,
    affected: &[Value],
) -> Result<Value, PromotionError> {
    let entries = load_entries(req.store, journal_id)?;
    Ok(json!({
        "schemaVersion": 1,
        "runId": req.run_id,
        "approvalId": req.approval_id,
        "workspaceId": req.workspace_id,
        "candidateManifestObjectDigest": req.candidate_manifest_object_digest,
        "baseSnapshotRootDigest": req.base_snapshot_root_digest,
        "changeSetObjectDigest": req.change_set_object_digest,
        "journalObjectDigest": journal_plan_digest(&entries)?,
        "promotionMode": req.promotion_mode,
        "affectedPaths": affected,
        "completedAt": req.now,
        "outcome": "COMMITTED",
        "resultingRootDigest": snapshot_digest,
        "visibilityGuarantee": "ENTRY_LEVEL"
    }))
}

fn persist_receipt(
    req: &ApplyRequest<'_>,
    journal_id: &str,
    state: &str,
    receipt: &Value,
) -> Result<Value, PromotionError> {
    let signed_at = timestamp_now()?;
    let envelope = sign_envelope(
        "ApplyReceipt",
        receipt,
        req.signing_key,
        req.signature_key_id,
        req.signer_certificate_object_digest,
        &signed_at,
    )?;
    let digest = sha256_digest_tagged(
        &serde_json::to_vec(&envelope).map_err(|_| PromotionError::Protocol("receipt json"))?,
    );
    set_journal_state(req.store, journal_id, state, Some(&digest))?;
    Ok(envelope)
}

pub use recovery::reconcile_all;
