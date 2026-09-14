use crate::config::{RunnerError, sha256_hex};
use crate::snapshot::git_dir_is_plain_directory;
use crate::windows::handles::{
    FileIdentity, inspect_handle, open_reparse_handle, volume_identity_string,
};
use crate::windows::paths::{classify_snapshot_root, nfc};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const PROJECT_ID_MAX_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceBind {
    pub workspace_id: String,
    pub project_id: String,
    pub alias: String,
    pub canonical_root: String,
    pub volume_identity: String,
    pub root_file_identity: String,
    pub recovery_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindStatus {
    Ready(WorkspaceBind),
    CeremonyRequired(WorkspaceBind),
    BlockedNoGit,
    Drift(WorkspaceBind),
}

#[derive(Debug, Clone)]
pub struct ObservedRoot {
    pub canonical_root: String,
    pub volume_identity: String,
    pub root_file_identity: String,
    pub alias: String,
}

pub fn file_identity_hex(identity: &FileIdentity) -> String {
    let mut hex = String::with_capacity(32);
    for byte in identity.file_id {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

pub fn dos_display_path(final_path: &str) -> String {
    let stripped = final_path.strip_prefix(r"\\?\").unwrap_or(final_path);
    nfc(stripped.trim_end_matches(['\\', '/']))
}

pub fn paths_equivalent(left: &str, right: &str) -> bool {
    let a = dos_display_path(left)
        .replace('/', "\\")
        .to_ascii_lowercase();
    let b = dos_display_path(right)
        .replace('/', "\\")
        .to_ascii_lowercase();
    a == b
}

pub fn parse_origin_url(git_config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in git_config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_origin = trimmed.eq_ignore_ascii_case("[remote \"origin\"]");
            continue;
        }
        if !in_origin {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("url") else {
            continue;
        };
        let value = rest.trim().trim_start_matches('=').trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

pub fn slug_from_origin(url: &str) -> Option<String> {
    let folded = nfc(url).to_ascii_lowercase();
    let trimmed = folded
        .trim_end_matches('/')
        .trim_end_matches('\\')
        .trim_end_matches(".git");
    let last = trimmed
        .rsplit(['/', ':', '\\'])
        .find(|part| !part.is_empty())?;
    let mut slug = String::new();
    for ch in last.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            slug.push(ch);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').trim_matches('.').to_string();
    let slug = slug
        .trim_start_matches(|ch: char| !ch.is_ascii_alphanumeric())
        .to_string();
    if slug.is_empty() || !slug.as_bytes()[0].is_ascii_alphanumeric() {
        return None;
    }
    Some(truncate_project_id(&slug))
}

pub fn parse_hec_ids(text: &str) -> Option<(String, String)> {
    let value: Value = serde_json::from_str(text).ok()?;
    let project = value.get("projectId").and_then(Value::as_str)?;
    let workspace = value
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or(project);
    if !is_project_id(project) || !is_project_id(workspace) {
        return None;
    }
    Some((project.to_string(), workspace.to_string()))
}

pub fn is_project_id(value: &str) -> bool {
    if value.is_empty() || value.len() > PROJECT_ID_MAX_BYTES || nfc(value) != value {
        return false;
    }
    let bytes = value.as_bytes();
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(*b, b'.' | b'_' | b'-'))
}

fn identity_scoped_id(prefix: &str, observed: &ObservedRoot) -> String {
    let digest = sha256_hex(
        format!(
            "{}\0{}",
            observed.volume_identity, observed.root_file_identity
        )
        .as_bytes(),
    );
    truncate_project_id(&format!("{prefix}-{}", &digest[..32]))
}

pub fn alias_from_root(root: &str) -> String {
    Path::new(root)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("workspace")
        .to_string()
}

pub fn env_workspace_alias() -> Option<String> {
    std::env::var("PI_HEC_WORKSPACE_ALIAS")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn resolve_observed_root(observed: &Path) -> Result<ObservedRoot, RunnerError> {
    let classified = classify_snapshot_root(&observed.to_string_lossy())
        .map_err(|_| RunnerError::Identity("observed cwd is not a local snapshot root"))?;
    let git_root = walk_to_git_root(&classified.display)?;
    let handle = open_reparse_handle(&git_root)
        .map_err(|_| RunnerError::Identity("cannot open git root handle"))?;
    let meta = inspect_handle(&handle).map_err(|_| RunnerError::Identity("git root identity"))?;
    if meta.reparse_tag.is_some() {
        return Err(RunnerError::Identity("git root is a reparse point"));
    }
    if !meta.is_directory {
        return Err(RunnerError::Identity("git root is not a directory"));
    }
    let canonical_root = dos_display_path(&meta.final_path);
    let volume_identity = volume_identity_string(&meta.identity);
    let root_file_identity = file_identity_hex(&meta.identity);
    let alias = env_workspace_alias().unwrap_or_else(|| alias_from_root(&canonical_root));
    Ok(ObservedRoot {
        canonical_root,
        volume_identity,
        root_file_identity,
        alias,
    })
}

pub fn choose_ids(observed: &ObservedRoot) -> (String, String) {
    let root = Path::new(&observed.canonical_root);
    if let Some(ids) = read_hec_json(root) {
        return ids;
    }
    let project_id = read_origin_url(root)
        .and_then(|url| slug_from_origin(&url))
        .unwrap_or_else(|| identity_scoped_id("p", observed));
    (project_id, identity_scoped_id("ws", observed))
}

pub fn fingerprint(
    volume_identity: &str,
    root_file_identity: &str,
    canonical_root: &str,
) -> String {
    sha256_hex(format!("{volume_identity}\0{root_file_identity}\0{canonical_root}").as_bytes())
}

pub(crate) fn walk_to_git_root(start: &Path) -> Result<PathBuf, RunnerError> {
    let mut current = start.to_path_buf();
    for _ in 0..64 {
        if git_dir_is_plain_directory(&current).unwrap_or(false) {
            return Ok(current);
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent.to_path_buf();
    }
    Err(RunnerError::BlockedNoGit)
}

fn read_origin_url(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join(".git").join("config")).ok()?;
    parse_origin_url(&text)
}

fn read_hec_json(root: &Path) -> Option<(String, String)> {
    let text = fs::read_to_string(root.join(".pi").join("hec.json")).ok()?;
    parse_hec_ids(&text)
}

fn truncate_project_id(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        let next = format!("{out}{ch}");
        if next.len() > PROJECT_ID_MAX_BYTES {
            break;
        }
        out = next;
    }
    out.trim_end_matches(['-', '.', '_']).to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        ObservedRoot, choose_ids, is_project_id, parse_hec_ids, parse_origin_url, paths_equivalent,
        resolve_observed_root, slug_from_origin, walk_to_git_root,
    };
    use std::path::PathBuf;

    #[test]
    fn origin_slug_is_stable_and_schema_safe() {
        assert_eq!(
            slug_from_origin("https://github.com/Acme/My App.git").as_deref(),
            Some("my-app")
        );
        assert_eq!(
            slug_from_origin("git@github.com:Acme/widgets.git").as_deref(),
            Some("widgets")
        );
        assert!(is_project_id(
            slug_from_origin("https://x/y/z").unwrap().as_str()
        ));
        assert_eq!(
            parse_origin_url(
                "[core]\n\turl = nope\n[remote \"origin\"]\n\turl = https://ex/repo.git\n"
            ),
            Some("https://ex/repo.git".into())
        );
    }

    #[test]
    fn hec_json_ids_must_match_project_id_schema() {
        assert_eq!(
            parse_hec_ids(r#"{"projectId":"acme.app","workspaceId":"acme.ws"}"#),
            Some(("acme.app".into(), "acme.ws".into()))
        );
        assert!(parse_hec_ids(r#"{"projectId":"MyApp"}"#).is_none());
    }

    #[test]
    fn path_equivalence_strips_extended_prefix() {
        assert!(paths_equivalent(r"\\?\C:\work\app", r"C:\work\app"));
        assert!(!paths_equivalent(r"C:\work\app", r"C:\work\other"));
    }

    #[test]
    fn choose_ids_are_stable_per_volume_and_file_identity() {
        let first = ObservedRoot {
            canonical_root: r"C:\missing-origin\app".into(),
            volume_identity: "vol-a".into(),
            root_file_identity: "aa".repeat(8),
            alias: "app".into(),
        };
        let second = ObservedRoot {
            root_file_identity: "bb".repeat(8),
            ..first.clone()
        };
        let a = choose_ids(&first);
        let b = choose_ids(&first);
        let other = choose_ids(&second);
        assert_eq!(a, b);
        assert!(a.0.starts_with("p-"));
        assert!(a.1.starts_with("ws-"));
        assert_ne!(a.1, other.1);
        assert_ne!(a.0, a.1);
    }

    #[test]
    fn walk_to_git_root_stops_at_plain_git_directory() {
        let root = std::env::temp_dir().join(format!(
            "pi-hec-git-walk-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(1)
        ));
        let nested = root.join("app").join("src");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        let found = walk_to_git_root(&nested).expect("git walk");
        assert!(
            paths_equivalent(found.to_str().unwrap(), root.to_str().unwrap()),
            "{} vs {}",
            found.display(),
            root.display()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn observed_root_walks_up_from_crate_src_to_repo_git() {
        let nested = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let observed = resolve_observed_root(&nested).expect("git walk from crate src");
        let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let git_root = crate_dir
            .ancestors()
            .find(|path| path.join(".git").is_dir())
            .expect("repo git directory");
        assert!(
            paths_equivalent(&observed.canonical_root, git_root.to_str().unwrap()),
            "{} vs {}",
            observed.canonical_root,
            git_root.display()
        );
    }
}
