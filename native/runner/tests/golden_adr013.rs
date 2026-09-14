use pi_hec_runner::config::{RunnerConfig, RunnerError};
use pi_hec_runner::ensure::{EnsureOutcome, ensure_observed_workspace};
use pi_hec_runner::local_store::LocalStore;
use pi_hec_runner::workspace::{
    choose_ids, is_project_id, paths_equivalent, resolve_observed_root,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::const_new(());

const GOLDEN_IDS: &[&str] = &[
    "react-spa",
    "react-monorepo",
    "node-backend",
    "fullstack",
    "no-tests",
    "legacy-conventions",
    "with-specs",
    "incomplete-agents",
    "dirty-tree",
    "migration-public-api",
];

const GIT_ENV: [(&str, &str); 5] = [
    ("GIT_AUTHOR_NAME", "pi-hec"),
    ("GIT_AUTHOR_EMAIL", "hec@pi-hec.local"),
    ("GIT_COMMITTER_NAME", "pi-hec"),
    ("GIT_COMMITTER_EMAIL", "hec@pi-hec.local"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
];

struct EnvGuard {
    saved: Vec<(String, Option<String>)>,
}

impl EnvGuard {
    fn clear(keys: &[&str]) -> Self {
        let mut saved = Vec::new();
        for key in keys {
            saved.push(((*key).to_string(), std::env::var(key).ok()));
            unsafe {
                // Test isolation only: CWD bind must not inherit leftover PI_HEC_WORKSPACE_* overrides.
                std::env::remove_var(key);
            }
        }
        Self { saved }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            unsafe {
                // Restore process env after the CWD-bind assertions so other tests keep their overrides.
                match value {
                    Some(current) => std::env::set_var(key, current),
                    None => std::env::remove_var(key),
                }
            }
        }
    }
}

fn hooks_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("hooks root")
}

fn golden_parent() -> PathBuf {
    hooks_root()
        .parent()
        .expect("parent of hooks")
        .to_path_buf()
}

fn golden_root(repo_id: &str) -> PathBuf {
    golden_parent().join(format!("golden-{repo_id}"))
}

fn require_golden_root(repo_id: &str) -> PathBuf {
    let root = golden_root(repo_id);
    let git_dir = root.join(".git");
    assert!(
        git_dir.is_dir(),
        "golden project {repo_id} missing independent git at {}. Run evaluation adr013 tests first.",
        root.display()
    );
    root
}

fn nested_cwd(root: &Path) -> PathBuf {
    for candidate in [
        root.join("src").join("auth"),
        root.join("packages").join("app").join("src").join("auth"),
        root.join("apps").join("api").join("src").join("auth"),
        root.join("lib"),
        root.join("src"),
    ] {
        if candidate.is_dir() {
            return candidate;
        }
    }
    root.to_path_buf()
}

fn temp_config(name: &str) -> RunnerConfig {
    let dir = std::env::temp_dir().join(format!(
        "pi-hec-adr013-{}-{}-{}",
        name,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(1)
    ));
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

fn scratch_dir(name: &str) -> PathBuf {
    let dir = golden_parent().join(format!(
        "_adr013-{}-{}-{}",
        name,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(1)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let source = entry.path();
        let dest = to.join(&name);
        if source.is_dir() {
            copy_tree(&source, &dest);
        } else {
            fs::copy(&source, &dest).unwrap();
        }
    }
}

fn git(args: &[&str], cwd: &Path) {
    let mut command = Command::new("git");
    command.args(args).current_dir(cwd);
    for (key, value) in GIT_ENV {
        command.env(key, value);
    }
    let output = command.output().expect("git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_git(root: &Path) {
    git(&["init", "--initial-branch=main"], root);
    git(&["config", "core.autocrlf", "false"], root);
    git(&["config", "user.name", "pi-hec"], root);
    git(&["config", "user.email", "hec@pi-hec.local"], root);
    git(&["add", "-A"], root);
    git(
        &[
            "commit",
            "-m",
            "golden baseline",
            "--author",
            "pi-hec <hec@pi-hec.local>",
        ],
        root,
    );
}

fn bind_ids(root: &Path) -> (String, String, String, String, String) {
    let observed = resolve_observed_root(&nested_cwd(root)).expect("observed golden root");
    let (project_id, workspace_id) = choose_ids(&observed);
    (
        observed.canonical_root,
        observed.volume_identity,
        observed.root_file_identity,
        project_id,
        workspace_id,
    )
}

#[test]
fn extracted_golden_repos_bind_to_their_git_root_not_pi_hec() {
    let hooks = hooks_root();
    let mut identities = Vec::new();
    for repo_id in GOLDEN_IDS {
        let root = require_golden_root(repo_id);
        let observed = resolve_observed_root(&nested_cwd(&root)).expect("golden bind");
        assert!(
            paths_equivalent(&observed.canonical_root, root.to_str().unwrap()),
            "{} bound {} instead of {}",
            repo_id,
            observed.canonical_root,
            root.display()
        );
        assert!(
            !paths_equivalent(&observed.canonical_root, hooks.to_str().unwrap()),
            "{repo_id} must not bind to the PI-HEC git root"
        );
        let (project_id, workspace_id) = choose_ids(&observed);
        assert!(is_project_id(&project_id), "{project_id}");
        assert!(is_project_id(&workspace_id), "{workspace_id}");
        assert_ne!(project_id, observed.alias);
        assert_ne!(workspace_id, observed.alias);
        assert_ne!(workspace_id, project_id);
        identities.push((
            repo_id.to_string(),
            observed.volume_identity,
            observed.root_file_identity,
            workspace_id,
        ));
    }
    for (index, left) in identities.iter().enumerate() {
        for right in identities.iter().skip(index + 1) {
            assert_ne!(
                (&left.1, &left.2),
                (&right.1, &right.2),
                "{} and {} must not share a bind key",
                left.0,
                right.0
            );
            assert_ne!(
                left.3, right.3,
                "{} and {} must not share workspaceId",
                left.0, right.0
            );
        }
    }
}

#[test]
fn two_repos_named_app_receive_distinct_workspace_ids() {
    let source = require_golden_root("node-backend");
    let base = scratch_dir("app-collision");
    let left = base.join("left").join("app");
    let right = base.join("right").join("app");
    copy_tree(&source, &left);
    copy_tree(&source, &right);
    init_git(&left);
    init_git(&right);
    let left_bind = resolve_observed_root(&nested_cwd(&left)).expect("left app");
    let right_bind = resolve_observed_root(&nested_cwd(&right)).expect("right app");
    assert_eq!(left_bind.alias, "app");
    assert_eq!(right_bind.alias, "app");
    assert_ne!(left_bind.root_file_identity, right_bind.root_file_identity);
    let left_ids = choose_ids(&left_bind);
    let right_ids = choose_ids(&right_bind);
    assert_ne!(left_ids.1, right_ids.1);
    assert_ne!(left_ids.0, right_ids.0);
    let _ = fs::remove_dir_all(&base);
}

#[tokio::test]
async fn ensure_workspace_ceremonies_then_quiets_per_golden_identity() {
    let _lock = ENV_LOCK.lock().await;
    let _env = EnvGuard::clear(&[
        "PI_HEC_WORKSPACE_ID",
        "PI_HEC_WORKSPACE_ROOT",
        "PI_HEC_PROJECT_ID",
        "PI_HEC_WORKSPACE_ALIAS",
    ]);
    let first_root = require_golden_root("node-backend");
    let second_root = require_golden_root("react-spa");
    let config = temp_config("ensure");
    let store = Arc::new(LocalStore::open(&config).unwrap());
    let first =
        ensure_observed_workspace(&store, None, &config, &nested_cwd(&first_root), false, None)
            .await
            .expect("first ensure");
    match first {
        EnsureOutcome::CeremonyRequired { step, bind, .. } => {
            assert_eq!(step, "project-trust");
            assert!(
                paths_equivalent(&bind.canonical_root, first_root.to_str().unwrap()),
                "{}",
                bind.canonical_root
            );
            assert_ne!(bind.workspace_id, bind.alias);
        }
        other => panic!("expected ceremony, got {other:?}"),
    }
    let approved =
        ensure_observed_workspace(&store, None, &config, &nested_cwd(&first_root), true, None)
            .await
            .expect("approved ensure");
    let EnsureOutcome::Ready(first_ready) = approved else {
        panic!("expected ready after approval");
    };
    assert!(paths_equivalent(
        &first_ready.canonical_root,
        first_root.to_str().unwrap()
    ));
    let quiet =
        ensure_observed_workspace(&store, None, &config, &nested_cwd(&first_root), false, None)
            .await
            .expect("quiet ensure");
    let EnsureOutcome::Ready(quiet_ready) = quiet else {
        panic!("repeat ensure must stay silent");
    };
    assert_eq!(quiet_ready.workspace_id, first_ready.workspace_id);
    let second =
        ensure_observed_workspace(&store, None, &config, &nested_cwd(&second_root), true, None)
            .await
            .expect("second repo");
    let EnsureOutcome::Ready(second_ready) = second else {
        panic!("second golden repo should register independently");
    };
    assert_ne!(second_ready.workspace_id, first_ready.workspace_id);
    assert!(paths_equivalent(
        &second_ready.canonical_root,
        second_root.to_str().unwrap()
    ));
    assert!(
        store
            .lookup_workspace(&first_ready.alias)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .lookup_workspaces_by_identity(
                &first_ready.volume_identity,
                &first_ready.root_file_identity
            )
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn root_drift_requires_new_workspace_registration() {
    let _lock = ENV_LOCK.lock().await;
    let _env = EnvGuard::clear(&[
        "PI_HEC_WORKSPACE_ID",
        "PI_HEC_WORKSPACE_ROOT",
        "PI_HEC_PROJECT_ID",
        "PI_HEC_WORKSPACE_ALIAS",
    ]);
    let root = require_golden_root("fullstack");
    let (canonical, volume, file_id, project_id, workspace_id) = bind_ids(&root);
    let config = temp_config("drift");
    let store = Arc::new(LocalStore::open(&config).unwrap());
    store
        .register_workspace(
            &workspace_id,
            &project_id,
            r"C:\old\moved-fullstack",
            &volume,
            &file_id,
        )
        .unwrap();
    let drifted = ensure_observed_workspace(&store, None, &config, &nested_cwd(&root), false, None)
        .await
        .expect("drift ensure");
    match drifted {
        EnsureOutcome::CeremonyRequired { step, bind, .. } => {
            assert_eq!(step, "workspace-registration");
            assert!(paths_equivalent(&bind.canonical_root, &canonical));
            assert_eq!(bind.workspace_id, workspace_id);
        }
        other => panic!("expected drift ceremony, got {other:?}"),
    }
    let stored = store
        .decrypt_root_path(&workspace_id)
        .unwrap()
        .expect("stored root");
    assert_eq!(stored, r"C:\old\moved-fullstack");
}

#[test]
fn missing_git_is_blocked_instead_of_using_cwd() {
    let dir = scratch_dir("no-git");
    let error = resolve_observed_root(&dir).expect_err("no git");
    assert!(
        matches!(error, RunnerError::BlockedNoGit),
        "expected BlockedNoGit, got {error}"
    );
    let _ = fs::remove_dir_all(&dir);
}
