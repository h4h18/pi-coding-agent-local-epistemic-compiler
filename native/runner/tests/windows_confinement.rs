#![cfg(windows)]

use pi_hec_runner::config::{RunnerConfig, RunnerError};
use pi_hec_runner::local_store::LocalStore;
use pi_hec_runner::operations::handshake_connected_pipe;
use pi_hec_runner::windows::jobs::{launch_confined, BrokerJob};
use pi_hec_runner::windows::{inspect_client_process, pipe_name, validate_confined_client, ProcessIdentity};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::windows::named_pipe::ServerOptions;

fn temp_config(name: &str) -> RunnerConfig {
    let dir = std::env::temp_dir().join(format!(
        "pi-hec-runner-int-{}-{}",
        name,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    RunnerConfig {
        data_dir: dir.clone(),
        control_base_url: "https://control.local".into(),
        runner_id: "runner-test".into(),
        key_id: "key-test".into(),
        pi_executable: PathBuf::from(env!("CARGO_BIN_EXE_pi-hec-confined-probe")),
        pi_args: Vec::new(),
        pi_stdio_log: None,
        identity_dir: dir.join("identity"),
        capabilities_path: dir.join("capabilities.json"),
    }
}

fn probe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_pi-hec-confined-probe"))
}

#[test]
fn claimed_pid_mismatch_fails_closed_without_pipe() {
    let identity = ProcessIdentity {
        process_id: 44,
        creation_time: "2026-08-27T00:00:00.000Z".into(),
        user_sid: pi_hec_runner::windows::current_user_sid_string().unwrap(),
        is_app_container: true,
        has_restrictions: true,
        in_broker_job: true,
    };
    let err = validate_confined_client(&identity, 1, "2026-08-27T00:00:00.000Z").unwrap_err();
    assert!(matches!(err, RunnerError::ClaimMismatch));
}

#[test]
fn confined_fixture_cannot_read_dpapi_key_bytes() {
    let config = temp_config("dpapi-probe");
    let secret = *b"0123456789abcdef0123456789abcdef";
    let store = LocalStore::open(&config).unwrap();
    store.store_ed25519_secret(&secret).unwrap();
    let db = store.db_path().to_path_buf();
    let raw = std::fs::read(&db).unwrap();
    assert!(!raw.windows(secret.len()).any(|window| window == secret));
    let job = BrokerJob::create().expect("CreateJobObjectW");
    let hex: String = secret.iter().map(|b| format!("{b:02x}")).collect();
    let wrapped = store
        .get_metadata(pi_hec_runner::config::META_ED25519)
        .unwrap()
        .expect("wrapped secret");
    let wrapped_hex: String = wrapped.iter().map(|b| format!("{b:02x}")).collect();
    let child = launch_confined(
        &job,
        &probe(),
        &["extract-key", db.to_str().unwrap(), &hex, &wrapped_hex],
        None,
    )
    .expect("CreateProcess confined probe");
    assert!(child.wait_ms(15_000).expect("wait"));
    assert_ne!(child.exit_code().expect("exit"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claimed_pid_and_creation_time_mismatch_closes_pipe() {
    let config = temp_config("pipe-lie");
    let store = Arc::new(LocalStore::open(&config).unwrap());
    let instance = store.ensure_instance_id().unwrap();
    let job = Arc::new(BrokerJob::create().expect("job"));
    let name = format!(
        r"\\.\pipe\pi-hec-test-lie-{}-{}",
        std::process::id(),
        unix_nanos()
    );
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .in_buffer_size(pi_hec_runner::config::MAX_FRAME_BYTES)
        .out_buffer_size(pi_hec_runner::config::MAX_FRAME_BYTES)
        .create(&name)
        .expect("pipe");
    let probe_path = probe();
    let mut child = Command::new(&probe_path)
        .args(["pipe-hello", &name, "lie"])
        .spawn()
        .expect("spawn lying client");
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        server.connect().await.unwrap();
        handshake_connected_pipe(&mut server, store, job, None, instance, config).await
    })
    .await
    .expect("handshake timeout");
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        matches!(
            result,
            Err(RunnerError::ClaimMismatch) | Err(RunnerError::Handshake(_))
        ),
        "{result:?}"
    );
}

fn unix_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(1)
}

#[test]
fn pipe_name_uses_sid_hash_prefix() {
    let name = pipe_name().expect("sid hash");
    assert!(name.starts_with(r"\\.\pipe\pi-hec-v1-"));
    assert_eq!(name.len(), r"\\.\pipe\pi-hec-v1-".len() + 64);
}

#[test]
fn confined_launch_uses_restricted_token_and_job() {
    let job = BrokerJob::create().expect("job");
    let child = launch_confined(&job, &probe(), &["sleep", "300"], None).expect("launch");
    assert!(child.process_id > 0);
    assert!(job
        .contains_process(child.process_handle())
        .expect("IsProcessInJob"));
    let identity = inspect_client_process(child.process_id, job.handle()).expect("inspect");
    assert!(
        identity.has_restrictions || identity.is_app_container,
        "restricted={}, appcontainer={}",
        identity.has_restrictions,
        identity.is_app_container
    );
    let _ = child.wait_ms(5_000);
}

#[test]
fn cargo_bin_probe_exists() {
    assert!(probe().is_file());
}
