use crate::local_store::LocalStore;
use super::journal::workspace_recovery;
use super::PromotionError;
use crate::snapshot::manifest::{snapshot_root_digest, tagged_hash, unicode_simple_fold_table_digest, windows_dir_entry};
use crate::windows::handles::{enumerate_directory, inspect_handle, open_reparse_handle, volume_identity_string};
use crate::windows::paths::classify_snapshot_root;
use crate::windows::replace::{content_digest, inspect_path, read_bytes};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub(crate) fn join_rel(root: &Path, relative: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
    }
    path
}

fn relative_from(root: &Path, child: &Path) -> String {
    child
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

pub fn candidate_tree_digest(root: &Path) -> Result<String, PromotionError> {
    let mut entries = Vec::new();
    walk_tree(root, root, &mut entries)?;
    tagged_hash("candidate-tree", 1, &json!({ "entries": entries })).map_err(PromotionError::from)
}

fn walk_tree(root: &Path, dir: &Path, out: &mut Vec<Value>) -> Result<(), PromotionError> {
    let listing = enumerate_directory(dir).map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
    for dent in listing {
        let child = dir.join(&dent.name);
        let rel = relative_from(root, &child);
        let handle = open_reparse_handle(&child)
            .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
        let opened = inspect_handle(&handle)
            .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
        if opened.is_directory {
            out.push(json!({ "path": rel, "entryType": "directory" }));
            walk_tree(root, &child, out)?;
        } else {
            let bytes = read_bytes(&child)?;
            out.push(json!({
                "path": rel,
                "entryType": "file",
                "contentDigest": content_digest(&bytes),
                "size": bytes.len() as u64,
                "gitMode": "100644"
            }));
        }
    }
    Ok(())
}

pub fn workspace_snapshot_root(root: &Path, workspace_id: &str) -> Result<String, PromotionError> {
    let classified = classify_snapshot_root(&root.to_string_lossy())
        .map_err(|_| PromotionError::Protocol("workspace path"))?;
    let handle = open_reparse_handle(&classified.display)
        .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
    let opened = inspect_handle(&handle)
        .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
    let mut snap_entries = Vec::new();
    collect_snapshot_entries(root, root, &mut snap_entries)?;
    let payload = json!({
        "repositoryId": "local",
        "workspaceId": workspace_id,
        "dirty": true,
        "filesystem": {
            "rootChildNameComparison": "case-insensitive",
            "unicodeNormalization": "NFC",
            "unicodeSimpleFoldTableObjectDigest": unicode_simple_fold_table_digest()?,
            "pathGlobDialect": "pi-hec-pathglob/v1",
            "volumeIdentity": volume_identity_string(&opened.identity)
        },
        "entries": snap_entries,
        "ignoredPathDigests": [],
        "excludedPaths": []
    });
    snapshot_root_digest(&payload).map_err(PromotionError::from)
}

fn collect_snapshot_entries(root: &Path, dir: &Path, out: &mut Vec<Value>) -> Result<(), PromotionError> {
    let listing = enumerate_directory(dir).map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
    for dent in listing {
        let child = dir.join(&dent.name);
        let rel = relative_from(root, &child);
        let handle = open_reparse_handle(&child)
            .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
        let opened = inspect_handle(&handle)
            .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
        let ads: Vec<Value> = opened
            .streams
            .iter()
            .map(|s| json!({ "name": s.name, "size": s.size }))
            .collect();
        if opened.is_directory {
            out.push(windows_dir_entry(
                &rel,
                "case-insensitive",
                &opened.identity.encoded(),
                &opened.security_descriptor_digest,
                &ads,
            ));
            collect_snapshot_entries(root, &child, out)?;
        } else {
            let bytes = read_bytes(&child)?;
            let digest = content_digest(&bytes);
            let mut meta = json!({
                "kind": "windows",
                "fileId": opened.identity.encoded(),
                "securityDescriptorDigest": opened.security_descriptor_digest,
                "alternateStreams": ads
            });
            if let Some(tag) = opened.reparse_tag {
                meta["reparseTag"] = json!(tag);
            }
            out.push(json!({
                "path": rel,
                "platformMetadata": meta,
                "entryType": "file",
                "contentDigest": digest,
                "size": opened.size,
                "gitMode": "100644",
                "storage": { "kind": "blob", "objectDigest": digest }
            }));
        }
    }
    Ok(())
}

pub fn current_file_digest(root: &Path, relative: &str) -> Result<Option<String>, PromotionError> {
    let dest = join_rel(root, relative);
    if !dest.exists() {
        return Ok(None);
    }
    Ok(Some(content_digest(&read_bytes(&dest)?)))
}

pub fn read_workspace_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, PromotionError> {
    let mut out = BTreeMap::new();
    collect_files(root, root, &mut out)?;
    Ok(out)
}

fn collect_files(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) -> Result<(), PromotionError> {
    let listing = enumerate_directory(dir).map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
    for dent in listing {
        let child = dir.join(&dent.name);
        let handle = open_reparse_handle(&child)
            .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
        let opened = inspect_handle(&handle)
            .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
        if opened.is_directory {
            collect_files(root, &child, out)?;
        } else {
            out.insert(relative_from(root, &child), read_bytes(&child)?);
        }
    }
    Ok(())
}

pub fn lease_state(store: &LocalStore, workspace_id: &str) -> Result<Option<(String, Option<String>)>, PromotionError> {
    Ok(workspace_recovery(store, workspace_id)?)
}

pub fn streams_of(path: &Path) -> Result<Vec<(String, Vec<u8>)>, PromotionError> {
    let opened = inspect_path(path)?;
    let mut out = Vec::new();
    for stream in opened.streams {
        let bytes = crate::windows::handles::read_named_stream(path, &stream.name)
            .map_err(|err| PromotionError::Io(std::io::Error::other(err.to_string())))?;
        out.push((stream.name, bytes));
    }
    Ok(out)
}

pub fn security_digest_of(path: &Path) -> Result<String, PromotionError> {
    Ok(inspect_path(path)?.security_descriptor_digest)
}
