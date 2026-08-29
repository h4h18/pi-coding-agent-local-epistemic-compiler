#![allow(clippy::too_many_arguments)]

use crate::config::{canonical_json, new_prefixed_id, sha256_digest_tagged, timestamp_now, RunnerError};
use crate::snapshot::chunker::{collect_blob_payloads, store_streamed};
use crate::snapshot::git::{
    git_blob_oid_from_storage, inspect_git, is_lfs_pointer, load_dir_gitignore, GitState, IgnoreRules,
};
use crate::snapshot::manifest::{
    git_history_root_digest, hmac_ignored_path, sign_envelope, snapshot_root_digest, unicode_simple_fold_table_digest,
    windows_dir_entry, windows_file_entry, windows_submodule_entry, windows_symlink_entry,
};
use crate::windows::handles::{
    assert_contained, classify_reparse, enumerate_directory, inspect_handle, open_reparse_handle, read_handle_chunk,
    read_named_stream, rewind_handle, symlink_target, volume_identity_string, HandleError, OpenedFile, ReparseClass,
};
use crate::windows::paths::{
    classify_snapshot_root, long_path_for, names_collide, reject_if_8_3_opened, reject_if_component_opened_as_8_3,
    PathReject,
};
use crate::windows::vss::{try_create_vss, VssError};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub const CHUNK_BYTES: u64 = crate::snapshot::chunker::CHUNK_BYTES;

mod chunker;
mod git;
pub mod manifest;

pub use git::is_lfs_pointer as lfs_pointer_identity;

#[derive(Debug)]
pub enum SnapshotError {
    Unstable,
    Escape(&'static str),
    Path(PathReject),
    Io(std::io::Error),
    Git(&'static str),
    Protocol(&'static str),
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unstable => f.write_str("SNAPSHOT_UNSTABLE"),
            Self::Escape(code) => write!(f, "SNAPSHOT_ESCAPE:{code}"),
            Self::Path(reject) => write!(f, "SNAPSHOT_ESCAPE:{}", reject.code()),
            Self::Io(error) => write!(f, "io: {error}"),
            Self::Git(msg) => write!(f, "git: {msg}"),
            Self::Protocol(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for SnapshotError {}

impl From<PathReject> for SnapshotError {
    fn from(value: PathReject) -> Self {
        Self::Path(value)
    }
}

impl From<std::io::Error> for SnapshotError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<HandleError> for SnapshotError {
    fn from(value: HandleError) -> Self {
        match value {
            HandleError::Path(reject) => Self::Path(reject),
            HandleError::Io(error) => Self::Io(error),
        }
    }
}

impl From<VssError> for SnapshotError {
    fn from(value: VssError) -> Self {
        match value {
            VssError::Unexpected(msg) => Self::Protocol(msg),
        }
    }
}

impl From<RunnerError> for SnapshotError {
    fn from(_: RunnerError) -> Self {
        Self::Protocol("runner")
    }
}

pub struct SnapshotRequest<'a> {
    pub repository_id: &'a str,
    pub workspace_id: &'a str,
    pub runner_id: &'a str,
    pub root: &'a Path,
    pub project_metadata_key: &'a [u8; 32],
    pub signing_key: &'a SigningKey,
    pub signature_key_id: &'a str,
    pub signer_certificate_object_digest: &'a str,
    pub force_no_vss: bool,
    pub mutate_between_scans: Option<&'a dyn Fn(&Path)>,
}

#[derive(Debug)]
pub struct SnapshotCapture {
    pub manifest: Value,
    pub envelope: Value,
    pub blobs: Vec<(String, Vec<u8>)>,
    pub git_history: Option<Value>,
    pub used_vss: bool,
}

struct Walked {
    entries: Vec<Value>,
    ignored: Vec<String>,
    excluded: Vec<Value>,
    blobs: Vec<(String, Vec<u8>)>,
    dirty: bool,
    volume: String,
    root_cmp: String,
    git_head: Option<String>,
    git_branch: Option<String>,
    git_index_digest: Option<String>,
    git_history: Option<Value>,
    git_history_root: Option<String>,
    git_history_object: Option<String>,
    identities: HashMap<String, u32>,
    seen_links: HashMap<String, u32>,
}

impl Walked {
    fn fingerprint(&self) -> Result<String, SnapshotError> {
        let payload = json!({
            "entries": self.entries,
            "ignored": self.ignored,
            "excluded": self.excluded,
            "dirty": self.dirty
        });
        Ok(sha256_digest_tagged(&canonical_json(&payload)?))
    }
}

pub fn capture_workspace(req: &SnapshotRequest<'_>) -> Result<SnapshotCapture, SnapshotError> {
    let classified = classify_snapshot_root(&req.root.to_string_lossy())?;
    let long = long_path_for(&classified.display)?;
    reject_if_8_3_opened(&classified.display, &long)?;
    let shadow = if req.force_no_vss {
        None
    } else {
        try_create_vss(&classified.display)?
    };
    let used_vss = shadow.is_some();
    let read_root = shadow
        .as_ref()
        .map(|s| s.map_path(&classified.display))
        .unwrap_or_else(|| classified.display.clone());
    let first = walk_tree(req, &read_root)?;
    let walked = if used_vss {
        first
    } else {
        if let Some(mutate) = req.mutate_between_scans {
            mutate(&classified.display);
        }
        let second = walk_tree(req, &read_root)?;
        if first.fingerprint()? != second.fingerprint()? {
            return Err(SnapshotError::Unstable);
        }
        first
    };
    for (id, nlink) in &walked.identities {
        let seen = walked.seen_links.get(id).copied().unwrap_or(0);
        if *nlink > 1 && seen < *nlink {
            return Err(SnapshotError::Escape("HARDLINK"));
        }
    }
    let filesystem = json!({
        "platform": "windows",
        "rootChildNameComparison": walked.root_cmp,
        "unicodeNormalization": "NFC",
        "unicodeSimpleFoldTableObjectDigest": unicode_simple_fold_table_digest()?,
        "pathGlobDialect": "pi-hec-pathglob/v1",
        "volumeIdentity": walked.volume
    });
    let snapshot_id = new_prefixed_id("snap_")?;
    let signed_at = timestamp_now()?;
    let mut git_history = walked.git_history.clone();
    let mut git_history_root = walked.git_history_root.clone();
    let mut git_history_object = walked.git_history_object.clone();
    let mut blobs = walked.blobs;
    if let Some(history) = git_history.as_mut() {
        history["repositoryId"] = json!(req.repository_id);
        history["snapshotId"] = json!(snapshot_id);
        let history_payload = json!({
            "repositoryId": req.repository_id,
            "refs": history.get("refs").cloned().unwrap_or(json!([])),
            "commits": history.get("commits").cloned().unwrap_or(json!([])),
            "shallowBoundaryObjectIds": history.get("shallowBoundaryObjectIds").cloned().unwrap_or(json!([])),
            "replaceRefsIgnored": true
        });
        let root_digest = git_history_root_digest(&history_payload)?;
        history["historyRootDigest"] = json!(root_digest);
        let envelope = sign_envelope(
            "GitHistoryManifest",
            history,
            req.signing_key,
            req.signature_key_id,
            req.signer_certificate_object_digest,
            &signed_at,
        )?;
        let envelope_bytes = canonical_json(&envelope)?;
        let object = sha256_digest_tagged(&envelope_bytes);
        git_history_root = Some(root_digest);
        git_history_object = Some(object.clone());
        blobs.push((object, envelope_bytes));
    }
    let mut manifest = json!({
        "schemaVersion": 1,
        "snapshotId": snapshot_id,
        "repositoryId": req.repository_id,
        "workspaceId": req.workspace_id,
        "dirty": walked.dirty,
        "filesystem": filesystem,
        "entries": walked.entries,
        "ignoredPathDigests": walked.ignored,
        "excludedPaths": walked.excluded,
        "createdAt": timestamp_now()?,
        "runnerId": req.runner_id
    });
    if let Some(head) = &walked.git_head {
        manifest["gitHead"] = json!(head);
    }
    if let Some(branch) = &walked.git_branch {
        manifest["gitBranch"] = json!(branch);
    }
    if let Some(index) = &walked.git_index_digest {
        manifest["gitIndexDigest"] = json!(index);
    }
    if let (Some(root), Some(obj)) = (&git_history_root, &git_history_object) {
        manifest["gitHistoryRootDigest"] = json!(root);
        manifest["gitHistoryManifestObjectDigest"] = json!(obj);
    }
    let root_payload = crate::snapshot::manifest::snapshot_root_payload(&manifest);
    manifest["rootDigest"] = json!(snapshot_root_digest(&root_payload)?);
    let envelope = sign_envelope(
        "SnapshotManifest",
        &manifest,
        req.signing_key,
        req.signature_key_id,
        req.signer_certificate_object_digest,
        &signed_at,
    )?;
    Ok(SnapshotCapture {
        manifest,
        envelope,
        blobs,
        git_history,
        used_vss,
    })
}

pub fn snapshot_commit_request(
    payload: &Value,
    signing_key: &SigningKey,
    key_id: &str,
    cert_digest: &str,
    signed_at: &str,
) -> Result<Value, SnapshotError> {
    let envelope = sign_envelope("SnapshotManifest", payload, signing_key, key_id, cert_digest, signed_at)?;
    let canonical = canonical_json(&envelope)?;
    let digest = sha256_digest_tagged(&canonical);
    Ok(json!({
        "schemaVersion": 1,
        "manifest": envelope,
        "manifestObjectDigest": digest
    }))
}

pub async fn upload_snapshot_blobs(
    api: &crate::api_client::ApiClient,
    store: &crate::local_store::LocalStore,
    project_id: &str,
    blobs: &[(String, Vec<u8>)],
) -> Result<(), SnapshotError> {
    let digests: Vec<String> = blobs.iter().map(|(d, _)| d.clone()).collect();
    let missing_resp = api
        .missing_blobs(store, project_id, &digests)
        .await
        .map_err(|_| SnapshotError::Protocol("missingBlobs"))?;
    if missing_resp.status != 200 {
        return Err(SnapshotError::Protocol("missingBlobs"));
    }
    let parsed: Value =
        serde_json::from_slice(&missing_resp.body).map_err(|_| SnapshotError::Protocol("missingBlobs json"))?;
    let missing: HashSet<String> = parsed
        .get("missingObjectDigests")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    for (digest, bytes) in blobs {
        if missing.contains(digest) || missing.is_empty() {
            let op = new_prefixed_id("op_").map_err(|_| SnapshotError::Protocol("op id"))?;
            let put = api
                .put_blob(store, &op, project_id, digest, bytes)
                .await
                .map_err(|_| SnapshotError::Protocol("putBlob"))?;
            if put.status != 201 && put.status != 204 {
                return Err(SnapshotError::Protocol("putBlob"));
            }
        }
    }
    Ok(())
}

pub async fn commit_snapshot_manifest(
    api: &crate::api_client::ApiClient,
    store: &crate::local_store::LocalStore,
    project_id: &str,
    snapshot_id: &str,
    payload: &Value,
    signing_key: &SigningKey,
    key_id: &str,
    cert_digest: &str,
) -> Result<crate::config::HttpResponse, SnapshotError> {
    let signed_at = timestamp_now()?;
    let body = snapshot_commit_request(payload, signing_key, key_id, cert_digest, &signed_at)?;
    let bytes = canonical_json(&body).map_err(|_| SnapshotError::Protocol("canonical"))?;
    let path = format!("/v1/projects/{}/snapshots/{}", project_id, snapshot_id);
    let op = new_prefixed_id("op_").map_err(|_| SnapshotError::Protocol("op id"))?;
    api.call(
        store,
        &op,
        Some(project_id),
        "commitSnapshot",
        "PUT",
        &path,
        "application/json",
        &bytes,
        &[],
        true,
    )
    .await
    .map_err(|_| SnapshotError::Protocol("commitSnapshot"))
}

fn walk_tree(req: &SnapshotRequest<'_>, read_root: &Path) -> Result<Walked, SnapshotError> {
    let root_handle = open_reparse_handle(read_root)?;
    let root_meta = inspect_handle(&root_handle)?;
    if let Some(tag) = root_meta.reparse_tag {
        classify_reparse(tag).map_err(|_| SnapshotError::Escape("REPARSE"))?;
    }
    let git = inspect_git(read_root)?;
    let mut walked = Walked {
        entries: Vec::new(),
        ignored: Vec::new(),
        excluded: Vec::new(),
        blobs: Vec::new(),
        dirty: git.dirty,
        volume: volume_identity_string(&root_meta.identity),
        root_cmp: child_cmp(root_meta.case_sensitive),
        git_head: git.head.clone(),
        git_branch: git.branch.clone(),
        git_index_digest: git.index_digest.clone(),
        git_history: git.history.clone(),
        git_history_root: git.history_root.clone(),
        git_history_object: git.history_object.clone(),
        identities: HashMap::new(),
        seen_links: HashMap::new(),
    };
    record_identity(&mut walked, &root_meta);
    walk_dir(
        req,
        read_root,
        read_root,
        "",
        &root_meta,
        &git,
        &git.ignore,
        &mut walked,
    )?;
    mark_deleted_tracked(&git, &mut walked);
    walked.entries.sort_by(|a, b| {
        let l = a.get("path").and_then(Value::as_str).unwrap_or("");
        let r = b.get("path").and_then(Value::as_str).unwrap_or("");
        l.cmp(r)
    });
    Ok(walked)
}

fn walk_dir(
    req: &SnapshotRequest<'_>,
    abs: &Path,
    read_root: &Path,
    rel: &str,
    root_meta: &OpenedFile,
    git: &GitState,
    ignore: &IgnoreRules,
    walked: &mut Walked,
) -> Result<(), SnapshotError> {
    let entries = enumerate_directory(abs)?;
    let case_sensitive = inspect_handle(&open_reparse_handle(abs)?)?.case_sensitive;
    for i in 0..entries.len() {
        for j in (i + 1)..entries.len() {
            if names_collide(&entries[i].name, &entries[j].name, case_sensitive) {
                return Err(SnapshotError::Escape("COLLISION"));
            }
        }
    }
    let dir_ignore = load_dir_gitignore(abs, &entries, ignore, read_root)?;
    for dent in entries {
        let child_rel = if rel.is_empty() {
            dent.name.clone()
        } else {
            format!("{rel}/{}", dent.name)
        };
        let child_abs = abs.join(&dent.name);
        let handle = open_reparse_handle(&child_abs)?;
        let meta = inspect_handle(&handle)?;
        assert_contained(root_meta, &meta).map_err(|_| SnapshotError::Escape("CONTAINMENT"))?;
        record_identity(walked, &meta);
        let long_child = long_path_for(&child_abs)?;
        reject_if_8_3_opened(&child_abs, &long_child)?;
        let opened_comp = dent.name.as_str();
        let long_comp = long_child
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| dent.name.clone());
        reject_if_component_opened_as_8_3(opened_comp, &long_comp, &dent.alternate_name)?;
        if let Some(tag) = meta.reparse_tag {
            match classify_reparse(tag) {
                Ok(ReparseClass::Symlink) => {
                    let target = symlink_target(&handle)?;
                    walked.entries.push(windows_symlink_entry(
                        &child_rel,
                        &target,
                        &meta.identity.encoded(),
                        tag,
                        &meta.security_descriptor_digest,
                        &stream_values(&meta, &child_abs)?,
                    ));
                    continue;
                }
                Err(_) => return Err(SnapshotError::Escape("REPARSE")),
            }
        }
        if dent.name.eq_ignore_ascii_case(".git") {
            let impact = if rel.is_empty() { "none" } else { "possible" };
            walked.excluded.push(json!({
                "path": { "kind": "normalized-path", "value": child_rel },
                "reason": "git object contents captured as GitHistoryManifest, not as tree entries",
                "correctnessImpact": impact
            }));
            continue;
        }
        if meta.is_directory {
            if default_excluded_dir(&child_rel) && !git.tracked.contains(&child_rel) {
                push_exclusion(walked, &child_rel, "dependency or build directory", "none");
                continue;
            }
            if dir_ignore.is_ignored(&child_rel, true) && !git.tracked.contains(&child_rel) {
                record_ignored(req, walked, &child_rel, &dent.name);
                continue;
            }
            walked.entries.push(windows_dir_entry(
                &child_rel,
                &child_cmp(meta.case_sensitive),
                &meta.identity.encoded(),
                &meta.security_descriptor_digest,
                &stream_values(&meta, &child_abs)?,
            ));
            walk_dir(
                req,
                &child_abs,
                read_root,
                &child_rel,
                root_meta,
                git,
                &dir_ignore,
                walked,
            )?;
            continue;
        }
        if dir_ignore.is_ignored(&child_rel, false) && !git.tracked.contains(&child_rel) {
            record_ignored(req, walked, &child_rel, &dent.name);
            continue;
        }
        if default_excluded_file(&child_rel) && !git.tracked.contains(&child_rel) {
            push_exclusion(walked, &child_rel, "unrelated archive or binary", "possible");
            continue;
        }
        if let Some(oid) = git.submodules.get(&child_rel) {
            walked.entries.push(windows_submodule_entry(
                &child_rel,
                oid,
                &meta.identity.encoded(),
                &meta.security_descriptor_digest,
                &stream_values(&meta, &child_abs)?,
            ));
            continue;
        }
        rewind_handle(&handle)?;
        let (digest, storage) = store_streamed(meta.size, |buf| {
            read_handle_chunk(&handle, buf).map_err(|err| match err {
                HandleError::Io(io) => io,
                HandleError::Path(reject) => std::io::Error::other(reject.code()),
            })
        })?;
        let preview = preview_file(
            &storage,
            meta.size,
            git.object_ids.get(&child_rel).map(String::as_str),
        );
        let _ = preview.is_lfs;
        if let Some(false) = preview.git_oid_match {
            walked.dirty = true;
        }
        let git_mode = if git.executables.contains(&child_rel) {
            "100755"
        } else {
            "100644"
        };
        let git_oid = git.object_ids.get(&child_rel).map(String::as_str);
        for blob in collect_blob_payloads(&storage) {
            walked.blobs.push(blob);
        }
        walked.entries.push(windows_file_entry(
            &child_rel,
            &digest,
            meta.size,
            git_mode,
            git_oid,
            &storage,
            &meta.identity.encoded(),
            meta.reparse_tag,
            &meta.security_descriptor_digest,
            &stream_values(&meta, &child_abs)?,
        ));
        if !git.tracked.contains(&child_rel) {
            walked.dirty = true;
        }
    }
    Ok(())
}

struct FileStorageBlobPreview {
    is_lfs: bool,
    git_oid_match: Option<bool>,
}

fn preview_file(
    storage: &crate::snapshot::chunker::FileStorage,
    size: u64,
    index_oid: Option<&str>,
) -> FileStorageBlobPreview {
    let bytes_for_lfs: Option<&[u8]> = match storage {
        crate::snapshot::chunker::FileStorage::Blob { bytes, .. } => Some(bytes.as_slice()),
        crate::snapshot::chunker::FileStorage::Chunks { .. } => None,
    };
    let is_lfs = bytes_for_lfs.map(is_lfs_pointer).unwrap_or(false);
    let git_oid_match = index_oid.map(|oid| git_blob_oid_from_storage(size, storage) == oid);
    FileStorageBlobPreview {
        is_lfs,
        git_oid_match,
    }
}

fn mark_deleted_tracked(git: &GitState, walked: &mut Walked) {
    for path in &git.tracked {
        let present = walked
            .entries
            .iter()
            .any(|e| e.get("path").and_then(Value::as_str) == Some(path.as_str()));
        if !present {
            walked.dirty = true;
        }
    }
}

fn record_ignored(req: &SnapshotRequest<'_>, walked: &mut Walked, child_rel: &str, name: &str) {
    let hmac = hmac_ignored_path(req.project_metadata_key, child_rel);
    walked.ignored.push(hmac.clone());
    if secret_name(name) {
        walked.excluded.push(json!({
            "path": { "kind": "project-hmac", "value": hmac },
            "reason": "secret-bearing ignored file",
            "correctnessImpact": "blocking"
        }));
    }
}

fn stream_values(meta: &OpenedFile, path: &Path) -> Result<Vec<Value>, SnapshotError> {
    let mut out = Vec::new();
    for stream in &meta.streams {
        let bytes = read_named_stream(path, &stream.name)?;
        out.push(json!({
            "name": stream.name,
            "contentDigest": sha256_digest_tagged(&bytes),
            "byteSize": bytes.len() as u64
        }));
    }
    Ok(out)
}

fn record_identity(walked: &mut Walked, meta: &OpenedFile) {
    let id = meta.identity.encoded();
    walked.identities.insert(id.clone(), meta.link_count);
    *walked.seen_links.entry(id).or_insert(0) += 1;
}

fn child_cmp(case_sensitive: bool) -> String {
    if case_sensitive {
        "case-sensitive".into()
    } else {
        "case-insensitive".into()
    }
}

fn push_exclusion(walked: &mut Walked, path: &str, reason: &str, impact: &str) {
    walked.excluded.push(json!({
        "path": { "kind": "normalized-path", "value": path },
        "reason": reason,
        "correctnessImpact": impact
    }));
}

fn default_excluded_dir(rel: &str) -> bool {
    rel.split('/').any(|segment| {
        matches!(
            segment,
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | "out"
                | ".next"
                | "coverage"
                | "__pycache__"
                | ".cache"
                | ".turbo"
                | ".venv"
                | "venv"
        )
    })
}

fn default_excluded_file(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".zip")
        || lower.ends_with(".tar")
        || lower.ends_with(".tar.gz")
        || lower.ends_with(".7z")
        || lower.ends_with(".rar")
}

fn secret_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || lower.ends_with(".pem")
        || lower.ends_with(".pfx")
        || lower == "credentials.json"
        || lower == "id_rsa"
}
