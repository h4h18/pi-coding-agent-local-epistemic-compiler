use crate::config::RunnerError;
use crate::ensure::{EnsureOutcome, ensure_observed_workspace};
use crate::operations::{BrokerRuntime, read_frame, spawn_bound_child, write_frame};
use crate::windows::{
    attach_pipe_name, create_attach_pipe, current_process_claim, inspect_client_process,
    named_pipe_client_pid, validate_attach_client,
};
use serde_json::{Value, json};
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer};
use windows::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};

const PIPE_BUSY: i32 = 231;

pub async fn run_attach(cwd: Option<PathBuf>) -> Result<(), RunnerError> {
    let observed = cwd.unwrap_or(std::env::current_dir()?);
    let name = attach_pipe_name()?;
    let mut client = connect_attach_pipe(&name).await?;
    let (pid, created) = current_process_claim()?;
    let bind = json!({
        "protocolVersion": 1,
        "kind": "BIND",
        "observedCwd": observed.to_string_lossy(),
        "claimedProcessId": pid,
        "claimedProcessCreationTime": created
    });
    write_frame(&mut client, &crate::config::canonical_json(&bind)?).await?;
    let mut response = parse_attach_response(&read_frame(&mut client).await?)?;
    if response.status == "CEREMONY_REQUIRED" || response.status == "DRIFT" {
        if !prompt_approve(&observed, &response)? {
            return Err(RunnerError::Identity("workspace ceremony denied"));
        }
        let nonce = response
            .nonce
            .clone()
            .ok_or(RunnerError::Protocol("ceremony nonce"))?;
        let decide = json!({
            "protocolVersion": 1,
            "kind": "DECIDE",
            "observedCwd": observed.to_string_lossy(),
            "nonce": nonce,
            "decision": "APPROVE",
            "claimedProcessId": pid,
            "claimedProcessCreationTime": created
        });
        write_frame(&mut client, &crate::config::canonical_json(&decide)?).await?;
        response = parse_attach_response(&read_frame(&mut client).await?)?;
    }
    match response.status.as_str() {
        "SPAWNED" | "READY" => {
            if let Some(child) = response.spawned_process_id {
                wait_for_pid(child);
            }
            Ok(())
        }
        "BLOCKED_NO_GIT" => Err(RunnerError::BlockedNoGit),
        "DENIED" => Err(RunnerError::Identity("workspace ceremony denied")),
        _ => Err(RunnerError::Identity("attach failed")),
    }
}

pub async fn serve_attach(runtime: BrokerRuntime) -> Result<(), RunnerError> {
    let name = attach_pipe_name()?;
    let mut first = true;
    loop {
        let server = create_attach_pipe(&name, first)?;
        first = false;
        server.connect().await?;
        let mut pipe = server;
        let runtime = runtime.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_attach_connection(&runtime, &mut pipe).await {
                eprintln!("attach connection: {error}");
            }
        });
    }
}

async fn handle_attach_connection(
    runtime: &BrokerRuntime,
    pipe: &mut NamedPipeServer,
) -> Result<(), RunnerError> {
    loop {
        let frame = match read_frame(pipe).await {
            Ok(bytes) => bytes,
            Err(RunnerError::Io(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof
                    || error.kind() == std::io::ErrorKind::BrokenPipe =>
            {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let request = parse_strict_object(&frame)?;
        let pid = named_pipe_client_pid(pipe)?;
        let identity = inspect_client_process(pid, runtime.job.handle())?;
        let claimed_pid = request
            .get("claimedProcessId")
            .and_then(Value::as_u64)
            .ok_or(RunnerError::Handshake("claimedProcessId"))?;
        let claimed_time = request
            .get("claimedProcessCreationTime")
            .and_then(Value::as_str)
            .ok_or(RunnerError::Handshake("claimedProcessCreationTime"))?;
        validate_attach_client(&identity, claimed_pid, claimed_time)?;
        let kind = request
            .get("kind")
            .and_then(Value::as_str)
            .ok_or(RunnerError::Protocol("attach kind"))?;
        let cwd = request
            .get("observedCwd")
            .and_then(Value::as_str)
            .ok_or(RunnerError::Protocol("observedCwd"))?;
        let approved =
            kind == "DECIDE" && request.get("decision").and_then(Value::as_str) == Some("APPROVE");
        let nonce = request.get("nonce").and_then(Value::as_str);
        if kind == "DECIDE" && request.get("decision").and_then(Value::as_str) == Some("DENY") {
            write_frame(
                pipe,
                &crate::config::canonical_json(&json!({
                    "protocolVersion": 1,
                    "status": "DENIED"
                }))?,
            )
            .await?;
            continue;
        }
        let outcome = ensure_observed_workspace(
            &runtime.store,
            runtime.api.as_ref(),
            &runtime.config,
            Path::new(cwd),
            approved,
            nonce,
        )
        .await?;
        let payload = match outcome {
            EnsureOutcome::BlockedNoGit => json!({
                "protocolVersion": 1,
                "status": "BLOCKED_NO_GIT"
            }),
            EnsureOutcome::CeremonyRequired { bind, step, nonce } => json!({
                "protocolVersion": 1,
                "status": if step == "workspace-registration" { "DRIFT" } else { "CEREMONY_REQUIRED" },
                "workspaceId": bind.workspace_id,
                "projectId": bind.project_id,
                "alias": bind.alias,
                "ceremonyStep": step,
                "nonce": nonce
            }),
            EnsureOutcome::Ready(bind) => {
                let child = spawn_bound_child(runtime, bind).await?;
                json!({
                    "protocolVersion": 1,
                    "status": "SPAWNED",
                    "spawnedProcessId": child,
                })
            }
        };
        write_frame(pipe, &crate::config::canonical_json(&payload)?).await?;
    }
}

async fn connect_attach_pipe(name: &str) -> Result<NamedPipeClient, RunnerError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match ClientOptions::new().open(name) {
            Ok(client) => return Ok(client),
            Err(error)
                if error.raw_os_error() == Some(PIPE_BUSY)
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

struct AttachResponse {
    status: String,
    nonce: Option<String>,
    spawned_process_id: Option<u32>,
}

fn parse_attach_response(bytes: &[u8]) -> Result<AttachResponse, RunnerError> {
    let value = parse_strict_object(bytes)?;
    Ok(AttachResponse {
        status: value
            .get("status")
            .and_then(Value::as_str)
            .ok_or(RunnerError::Protocol("attach status"))?
            .to_string(),
        nonce: value
            .get("nonce")
            .and_then(Value::as_str)
            .map(str::to_string),
        spawned_process_id: value
            .get("spawnedProcessId")
            .and_then(Value::as_u64)
            .map(|id| id as u32),
    })
}

fn parse_strict_object(bytes: &[u8]) -> Result<serde_json::Map<String, Value>, RunnerError> {
    crate::operations::parse_strict_json(bytes)?
        .as_object()
        .cloned()
        .ok_or(RunnerError::Protocol("attach json object"))
}

fn prompt_approve(root: &Path, response: &AttachResponse) -> Result<bool, RunnerError> {
    if !io::stdin().is_terminal() {
        return Ok(false);
    }
    let step = if response.status == "DRIFT" {
        "workspace-registration (root moved)"
    } else {
        "project-trust"
    };
    print!("HEC {step} for {}? [y/N] ", root.display());
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    Ok(matches!(line.trim(), "y" | "Y" | "yes" | "YES"))
}

fn wait_for_pid(pid: u32) {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
            return;
        };
        loop {
            let status = WaitForSingleObject(handle, 500);
            if status != WAIT_TIMEOUT {
                break;
            }
        }
        let _ = CloseHandle(handle);
    }
}
