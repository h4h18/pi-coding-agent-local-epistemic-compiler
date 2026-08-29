#![allow(clippy::derivable_impls)]
#![allow(clippy::collapsible_match)]
#![allow(clippy::collapsible_if)]

use crate::config::{canonical_json, new_prefixed_id, sha256_digest_tagged};
use crate::snapshot::chunker::FileStorage;
use crate::snapshot::manifest::git_history_root_digest;
use crate::snapshot::{SnapshotError};
use crate::windows::handles::{
    inspect_handle, open_reparse_handle, read_handle_bytes, rewind_handle, HandleError,
};
use gix::bstr::BStr;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const LFS_VERSION: &str = "version https://git-lfs.github.com/spec/v1";
const LFS_MAX_BYTES: usize = 1024;

#[derive(Clone)]
pub struct IgnoreRules {
    search: gix::ignore::Search,
}

impl Default for IgnoreRules {
    fn default() -> Self {
        Self {
            search: gix::ignore::Search::default(),
        }
    }
}

impl IgnoreRules {
    pub fn add_gitignore_bytes(&mut self, bytes: &[u8], source: &Path, root: &Path) {
        self.search
            .add_patterns_buffer(bytes, source, Some(root), Default::default());
    }

    pub fn is_ignored(&self, relative: &str, is_dir: bool) -> bool {
        let normalized = relative.replace('\\', "/");
        match self.search.pattern_matching_relative_path(
            BStr::new(normalized.as_bytes()),
            Some(is_dir),
            gix::glob::pattern::Case::Fold,
        ) {
            Some(matched) => !matched.pattern.is_negative(),
            None => false,
        }
    }
}

pub struct GitState {
    pub dirty: bool,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub index_digest: Option<String>,
    pub history: Option<Value>,
    pub history_root: Option<String>,
    pub history_object: Option<String>,
    pub tracked: HashSet<String>,
    pub ignore: IgnoreRules,
    pub executables: HashSet<String>,
    pub object_ids: HashMap<String, String>,
    pub submodules: HashMap<String, String>,
}

pub fn inspect_git(root: &Path) -> Result<GitState, SnapshotError> {
    if !git_dir_is_plain_directory(root)? {
        return Ok(empty_git(true));
    }
    match capture_git_history(root) {
        Ok(state) => Ok(state),
        Err(SnapshotError::Git(_)) => {
            let mut state = empty_git(true);
            load_info_exclude(root, &mut state.ignore)?;
            Ok(state)
        }
        Err(error) => Err(error),
    }
}

pub fn git_dir_is_plain_directory(root: &Path) -> Result<bool, SnapshotError> {
    let git_dir = root.join(".git");
    match open_reparse_handle(&git_dir) {
        Err(HandleError::Io(_)) => Ok(false),
        Err(error) => Err(error.into()),
        Ok(handle) => {
            let meta = inspect_handle(&handle)?;
            if meta.reparse_tag.is_some() {
                return Ok(false);
            }
            Ok(meta.is_directory)
        }
    }
}

pub fn empty_git(dirty: bool) -> GitState {
    GitState {
        dirty,
        head: None,
        branch: None,
        index_digest: None,
        history: None,
        history_root: None,
        history_object: None,
        tracked: HashSet::new(),
        ignore: IgnoreRules::default(),
        executables: HashSet::new(),
        object_ids: HashMap::new(),
        submodules: HashMap::new(),
    }
}

pub fn is_lfs_pointer(bytes: &[u8]) -> bool {
    if bytes.len() >= LFS_MAX_BYTES {
        return false;
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut lines = text.lines();
    let Some(version) = lines.next() else {
        return false;
    };
    if version != LFS_VERSION {
        return false;
    }
    let mut has_oid = false;
    let mut has_size = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("oid sha256:") {
            has_oid = rest.len() == 64 && rest.bytes().all(|b| b.is_ascii_hexdigit());
        } else if let Some(rest) = line.strip_prefix("size ") {
            has_size = !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit());
        }
    }
    has_oid && has_size
}

pub fn git_blob_oid(bytes: &[u8]) -> String {
    git_blob_oid_sized(bytes.len() as u64, std::iter::once(bytes))
}

pub fn git_blob_oid_from_storage(size: u64, storage: &FileStorage) -> String {
    match storage {
        FileStorage::Blob { bytes, .. } => git_blob_oid(bytes),
        FileStorage::Chunks { chunks } => git_blob_oid_sized(size, chunks.iter().map(|c| c.bytes.as_slice())),
    }
}

fn git_blob_oid_sized<'a, I>(size: u64, parts: I) -> String
where
    I: IntoIterator<Item = &'a [u8]>,
{
    let mut hasher = gix::hash::hasher(gix::hash::Kind::Sha1);
    hasher.update(format!("blob {size}\0").as_bytes());
    for part in parts {
        hasher.update(part);
    }
    hasher.try_finalize().map(|id| id.to_string()).unwrap_or_default()
}

pub fn load_dir_gitignore(
    abs: &Path,
    entries: &[crate::windows::handles::Dirent],
    ignore: &IgnoreRules,
    read_root: &Path,
) -> Result<IgnoreRules, SnapshotError> {
    let mut next = ignore.clone();
    let Some(dent) = entries.iter().find(|d| d.name == ".gitignore") else {
        return Ok(next);
    };
    let path = abs.join(&dent.name);
    let handle = open_reparse_handle(&path)?;
    let meta = inspect_handle(&handle)?;
    if meta.reparse_tag.is_some() || meta.is_directory {
        return Ok(next);
    }
    rewind_handle(&handle)?;
    let bytes = read_handle_bytes(&handle)?;
    next.add_gitignore_bytes(&bytes, &path, read_root);
    Ok(next)
}

fn capture_git_history(root: &Path) -> Result<GitState, SnapshotError> {
    let opts = gix::open::Options::isolated();
    let repo = gix::open_opts(root, opts).map_err(|_| SnapshotError::Git("open"))?;
    let mut state = empty_git(false);
    if let Ok(head) = repo.head_id() {
        state.head = Some(head.to_string());
    }
    if let Ok(head_ref) = repo.head_name() {
        if let Some(name) = head_ref {
            state.branch = Some(name.as_bstr().to_string());
        }
    }
    if let Ok(index) = repo.index_or_empty() {
        for entry in index.entries() {
            let path = entry.path(&index).to_string();
            state.tracked.insert(path.clone());
            state.object_ids.insert(path.clone(), entry.id.to_string());
            if entry.mode == gix::index::entry::Mode::FILE_EXECUTABLE {
                state.executables.insert(path);
            } else if entry.mode == gix::index::entry::Mode::COMMIT {
                state.submodules.insert(path.clone(), entry.id.to_string());
            }
        }
        state.index_digest = Some(hash_gix_index(&index)?);
    }
    load_info_exclude(root, &mut state.ignore)?;
    let history = build_history_manifest(&repo, root)?;
    let history_payload = json!({
        "repositoryId": history.get("repositoryId").cloned().unwrap_or(json!("")),
        "refs": history.get("refs").cloned().unwrap_or(json!([])),
        "commits": history.get("commits").cloned().unwrap_or(json!([])),
        "shallowBoundaryObjectIds": history.get("shallowBoundaryObjectIds").cloned().unwrap_or(json!([])),
        "replaceRefsIgnored": true
    });
    let root_digest = git_history_root_digest(&history_payload)?;
    let mut history = history;
    history["historyRootDigest"] = json!(root_digest);
    let object = sha256_digest_tagged(&canonical_json(&history)?);
    state.history = Some(history);
    state.history_root = Some(root_digest);
    state.history_object = Some(object);
    Ok(state)
}

fn hash_gix_index(index: &gix::index::File) -> Result<String, SnapshotError> {
    let mut buf = Vec::new();
    index
        .write_to(&mut buf, gix::index::write::Options::default())
        .map_err(|_| SnapshotError::Git("index digest"))?;
    Ok(sha256_digest_tagged(&buf))
}

fn load_info_exclude(root: &Path, ignore: &mut IgnoreRules) -> Result<(), SnapshotError> {
    let path = root.join(".git").join("info").join("exclude");
    match open_reparse_handle(&path) {
        Err(HandleError::Io(_)) => Ok(()),
        Err(error) => Err(error.into()),
        Ok(handle) => {
            let meta = inspect_handle(&handle)?;
            if meta.reparse_tag.is_some() || meta.is_directory {
                return Ok(());
            }
            rewind_handle(&handle)?;
            let bytes = read_handle_bytes(&handle)?;
            ignore.add_gitignore_bytes(&bytes, &path, root);
            Ok(())
        }
    }
}

fn build_history_manifest(repo: &gix::Repository, root: &Path) -> Result<Value, SnapshotError> {
    let mut refs = Vec::new();
    if let Ok(platform) = repo.references() {
        if let Ok(iter) = platform.all() {
            for item in iter.flatten() {
                let name = item.name().as_bstr().to_string();
                if name.starts_with("refs/replace/") {
                    continue;
                }
                refs.push(json!({
                    "name": name,
                    "targetObjectId": item.id().to_string()
                }));
            }
        }
    }
    refs.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    let mut start_ids = Vec::new();
    for r in &refs {
        if let Some(id) = r.get("targetObjectId").and_then(Value::as_str) {
            if let Ok(oid) = gix::ObjectId::from_hex(id.as_bytes()) {
                start_ids.push(oid);
            }
        }
    }
    let mut commits = Vec::new();
    if !start_ids.is_empty() {
        if let Ok(walk) = repo.rev_walk(start_ids).all() {
            for info in walk.flatten() {
                let Ok(commit) = info.object() else {
                    continue;
                };
                let Ok(decoded) = commit.decode() else {
                    continue;
                };
                let parents: Vec<String> = decoded.parents().map(|p| p.to_string()).collect();
                let parent = decoded.parents().next();
                let changed = changed_paths(repo, &info.id, parent);
                commits.push(json!({
                    "objectId": info.id.to_string(),
                    "parentObjectIds": parents,
                    "authorTimestamp": signature_time(decoded.author()),
                    "committerTimestamp": signature_time(decoded.committer()),
                    "messageDigest": sha256_digest_tagged(decoded.message),
                    "changedPaths": changed
                }));
            }
        }
    }
    let shallow = read_shallow(root)?;
    let snapshot_id = new_prefixed_id("snap_")?;
    Ok(json!({
        "schemaVersion": 1,
        "repositoryId": "pending",
        "snapshotId": snapshot_id,
        "refs": refs,
        "commits": commits,
        "shallowBoundaryObjectIds": shallow,
        "replaceRefsIgnored": true
    }))
}

fn changed_paths(repo: &gix::Repository, id: &gix::ObjectId, parent: Option<gix::ObjectId>) -> Vec<String> {
    let Ok(current) = tree_path_oids(repo, *id) else {
        return Vec::new();
    };
    let previous = parent
        .and_then(|pid| tree_path_oids(repo, pid).ok())
        .unwrap_or_default();
    let mut changed = Vec::new();
    for (path, oid) in &current {
        if previous.get(path) != Some(oid) {
            changed.push(path.clone());
        }
    }
    for path in previous.keys() {
        if !current.contains_key(path) {
            changed.push(path.clone());
        }
    }
    changed.sort();
    changed.dedup();
    changed
}

fn tree_path_oids(
    repo: &gix::Repository,
    commit_id: gix::ObjectId,
) -> Result<HashMap<String, gix::ObjectId>, SnapshotError> {
    let obj = repo.find_object(commit_id).map_err(|_| SnapshotError::Git("object"))?;
    let tree = obj.peel_to_tree().map_err(|_| SnapshotError::Git("tree"))?;
    let mut out = HashMap::new();
    collect_tree_oids(repo, tree, "", &mut out)?;
    Ok(out)
}

fn collect_tree_oids(
    repo: &gix::Repository,
    tree: gix::Tree<'_>,
    prefix: &str,
    out: &mut HashMap<String, gix::ObjectId>,
) -> Result<(), SnapshotError> {
    let entries: Vec<_> = tree.iter().collect();
    for entry in entries.into_iter().flatten() {
        let name = entry.filename().to_string();
        let path = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let oid = entry.oid().to_owned();
        if entry.mode().is_tree() {
            let obj = repo.find_object(oid).map_err(|_| SnapshotError::Git("subtree"))?;
            let subtree = obj.try_into_tree().map_err(|_| SnapshotError::Git("subtree"))?;
            collect_tree_oids(repo, subtree, &path, out)?;
        } else {
            out.insert(path, oid);
        }
    }
    Ok(())
}

fn signature_time(sig: Result<gix::actor::SignatureRef<'_>, gix::objs::decode::Error>) -> String {
    let Ok(sig) = sig else {
        return crate::config::unix_millis_to_rfc3339(0);
    };
    match sig.time() {
        Ok(time) => git_time(time),
        Err(_) => crate::config::unix_millis_to_rfc3339(0),
    }
}

fn git_time(time: gix::date::Time) -> String {
    let millis = u64::try_from(time.seconds.max(0)).unwrap_or(0).saturating_mul(1000);
    crate::config::unix_millis_to_rfc3339(millis)
}

fn read_shallow(root: &Path) -> Result<Vec<String>, SnapshotError> {
    let path = root.join(".git").join("shallow");
    match open_reparse_handle(&path) {
        Err(HandleError::Io(_)) => Ok(Vec::new()),
        Err(error) => Err(error.into()),
        Ok(handle) => {
            let meta = inspect_handle(&handle)?;
            if meta.reparse_tag.is_some() || meta.is_directory {
                return Ok(Vec::new());
            }
            rewind_handle(&handle)?;
            let bytes = read_handle_bytes(&handle)?;
            let text = String::from_utf8_lossy(&bytes);
            Ok(text
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect())
        }
    }
}
