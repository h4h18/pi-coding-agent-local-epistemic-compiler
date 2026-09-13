#![allow(clippy::collapsible_if)]

use crate::api_client::{claim_loop, ApiClient, HttpResponse};
use crate::config::{
    canonical_json, new_prefixed_id, nonce_256, quoted_state_version, sha256_digest_tagged, sha256_hex,
    timestamp_now, unix_millis_now, unix_millis_to_rfc3339, MAX_FRAME_BYTES, MAX_OUTSTANDING_REQUESTS,
    PROTOCOL_VERSION, RunnerConfig, RunnerError,
};
use crate::local_store::LocalStore;
use crate::windows::jobs::{launch_confined, BrokerJob, ConfinedChild};
use crate::windows::{
    create_broker_pipe, inspect_client_process, named_pipe_client_pid, pipe_name, validate_confined_client,
};
use serde_json::{Map, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::windows::named_pipe::NamedPipeServer;

const STILL_ACTIVE: u32 = 259;

pub async fn run_broker() -> Result<(), RunnerError> {
    let config = RunnerConfig::from_env()?;
    let store = LocalStore::open(&config)?;
    store.enroll_identity_from_disk(&config)?;
    bootstrap_workspace_from_env(&store)?;
    let instance_id = store.ensure_instance_id()?;
    let job = Arc::new(BrokerJob::create()?);
    let client = match ApiClient::from_store(&store, &config.control_base_url, &config.key_id) {
        Ok(client) => Some(client),
        Err(RunnerError::Identity(_)) => None,
        Err(error) => return Err(error),
    };
    let capabilities = if client.is_some() {
        Some(store.load_capabilities_digest(&config.capabilities_path)?)
    } else {
        None
    };
    let store = Arc::new(store);
    let pipe = PipeListener {
        config,
        store: store.clone(),
        job,
        api: client.clone(),
        instance_id,
    };
    if let (Some(api), Some(capabilities)) = (client, capabilities) {
        let runner_id = pipe.config.runner_id.clone();
        tokio::select! {
            result = pipe.serve() => result,
            result = claim_loop(api, store, runner_id, capabilities) => result,
        }
    } else {
        pipe.serve().await
    }
}

struct PipeListener {
    config: RunnerConfig,
    store: Arc<LocalStore>,
    job: Arc<BrokerJob>,
    api: Option<ApiClient>,
    instance_id: String,
}

impl PipeListener {
    async fn serve(&self) -> Result<(), RunnerError> {
        let name = pipe_name()?;
        let mut first_instance = true;
        let mut server = create_broker_pipe(&name, first_instance)?;
        first_instance = false;
        let pi: ConfinedChild = launch_pi_blocking(&self.config, self.job.clone()).await?;
        loop {
            match await_pipe_client(&mut server, &pi).await? {
                PipeWait::Connected => {}
                PipeWait::ChildExited => return Ok(()),
            }
            if let Err(error) = self.handle_connection(&mut server).await {
                if !matches!(
                    error,
                    RunnerError::Handshake(_)
                        | RunnerError::ClaimMismatch
                        | RunnerError::Frame(_)
                        | RunnerError::SequenceGap
                        | RunnerError::OversizeFrame
                        | RunnerError::ZeroLengthFrame
                        | RunnerError::CanonicalJson
                        | RunnerError::DuplicateJsonKey
                        | RunnerError::TrailingBytes
                        | RunnerError::OutstandingLimit
                ) {
                    return Err(error);
                }
            }
            if pi.exit_code()? != STILL_ACTIVE {
                return Ok(());
            }
            server = create_broker_pipe(&name, first_instance)?;
        }
    }

    async fn handle_connection(&self, pipe: &mut NamedPipeServer) -> Result<(), RunnerError> {
        let connection_id = new_prefixed_id("conn_")?;
        let hello = serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "brokerInstanceId": self.instance_id,
            "connectionId": connection_id,
            "brokerNonce": nonce_256()?,
            "maxFrameBytes": MAX_FRAME_BYTES,
            "confinementRequired": true
        });
        write_frame(pipe, &canonical_json(&hello)?).await?;
        let client_hello = read_frame(pipe).await?;
        let hello_value = parse_strict_json(&client_hello)?;
        let pi = parse_pi_client_hello(&hello_value)?;
        if pi.connection_id != connection_id {
            return Err(RunnerError::Handshake("connectionId mismatch"));
        }
        let pid = named_pipe_client_pid(pipe)?;
        let identity = inspect_client_process(pid, self.job.handle())?;
        validate_confined_client(&identity, pi.claimed_process_id, &pi.claimed_creation_time)?;
        let mut expected_sequence = 1u64;
        let mut outstanding = 0usize;
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
            if outstanding >= MAX_OUTSTANDING_REQUESTS {
                return Err(RunnerError::OutstandingLimit);
            }
            let value = parse_strict_json(&frame)?;
            let parsed = parse_broker_frame(&value)?;
            if parsed.connection_id != connection_id {
                return Err(RunnerError::Handshake("frame connectionId mismatch"));
            }
            if parsed.sequence != expected_sequence {
                return Err(RunnerError::SequenceGap);
            }
            expected_sequence += 1;
            outstanding += 1;
            let response = dispatch_request(&parsed.body, &self.store, self.api.as_ref()).await;
            let encoded = canonical_json(&response)?;
            write_frame(pipe, &encoded).await?;
            outstanding -= 1;
        }
    }

}

pub async fn dispatch_request(
    body: &Value,
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
) -> Value {
    match handle_request(body, store, api).await {
        Ok(value) => value,
        Err(error) => error_response(request_id_of(body), error),
    }
}

pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, body: &[u8]) -> Result<(), RunnerError> {
    if body.is_empty() {
        return Err(RunnerError::ZeroLengthFrame);
    }
    if body.len() > MAX_FRAME_BYTES as usize {
        return Err(RunnerError::OversizeFrame);
    }
    let len = (body.len() as u32).to_be_bytes();
    writer.write_all(&len).await?;
    writer.write_all(body).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, RunnerError> {
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf);
    if len == 0 {
        return Err(RunnerError::ZeroLengthFrame);
    }
    if len > MAX_FRAME_BYTES {
        return Err(RunnerError::OversizeFrame);
    }
    let mut body = vec![0u8; len as usize];
    reader.read_exact(&mut body).await?;
    Ok(body)
}

pub fn parse_strict_json(bytes: &[u8]) -> Result<Value, RunnerError> {
    let text = std::str::from_utf8(bytes).map_err(|_| RunnerError::CanonicalJson)?;
    reject_duplicate_keys(text)?;
    let value: Value = serde_json::from_str(text).map_err(|_| RunnerError::CanonicalJson)?;
    let canonical = canonical_json(&value)?;
    if canonical.as_slice() != bytes {
        return Err(RunnerError::CanonicalJson);
    }
    Ok(value)
}

fn reject_duplicate_keys(text: &str) -> Result<(), RunnerError> {
    let bytes = text.as_bytes();
    let (consumed, _) = parse_value(bytes, 0)?;
    if consumed != bytes.len() {
        return Err(RunnerError::TrailingBytes);
    }
    Ok(())
}

fn parse_value(bytes: &[u8], mut i: usize) -> Result<(usize, ()), RunnerError> {
    i = skip_ws(bytes, i);
    let Some(&b) = bytes.get(i) else {
        return Err(RunnerError::CanonicalJson);
    };
    match b {
        b'n' => consume_lit(bytes, i, b"null"),
        b't' => consume_lit(bytes, i, b"true"),
        b'f' => consume_lit(bytes, i, b"false"),
        b'"' => parse_string(bytes, i).map(|(n, _)| (n, ())),
        b'{' => parse_object(bytes, i),
        b'[' => parse_array(bytes, i),
        b'-' | b'0'..=b'9' => parse_number(bytes, i),
        _ => Err(RunnerError::CanonicalJson),
    }
}

fn parse_object(bytes: &[u8], mut i: usize) -> Result<(usize, ()), RunnerError> {
    i += 1;
    i = skip_ws(bytes, i);
    let mut seen = Vec::<String>::new();
    if bytes.get(i) == Some(&b'}') {
        return Ok((i + 1, ()));
    }
    loop {
        i = skip_ws(bytes, i);
        let (next, key) = parse_string(bytes, i)?;
        if seen.iter().any(|existing| existing == &key) {
            return Err(RunnerError::DuplicateJsonKey);
        }
        seen.push(key);
        i = skip_ws(bytes, next);
        if bytes.get(i) != Some(&b':') {
            return Err(RunnerError::CanonicalJson);
        }
        let (after, _) = parse_value(bytes, i + 1)?;
        i = skip_ws(bytes, after);
        match bytes.get(i) {
            Some(&b',') => i += 1,
            Some(&b'}') => return Ok((i + 1, ())),
            _ => return Err(RunnerError::CanonicalJson),
        }
    }
}

fn parse_array(bytes: &[u8], mut i: usize) -> Result<(usize, ()), RunnerError> {
    i += 1;
    i = skip_ws(bytes, i);
    if bytes.get(i) == Some(&b']') {
        return Ok((i + 1, ()));
    }
    loop {
        let (after, _) = parse_value(bytes, i)?;
        i = skip_ws(bytes, after);
        match bytes.get(i) {
            Some(&b',') => i += 1,
            Some(&b']') => return Ok((i + 1, ())),
            _ => return Err(RunnerError::CanonicalJson),
        }
    }
}

fn parse_string(bytes: &[u8], mut i: usize) -> Result<(usize, String), RunnerError> {
    if bytes.get(i) != Some(&b'"') {
        return Err(RunnerError::CanonicalJson);
    }
    i += 1;
    let mut out = String::new();
    while let Some(&b) = bytes.get(i) {
        match b {
            b'"' => return Ok((i + 1, out)),
            b'\\' => {
                i += 1;
                let esc = *bytes.get(i).ok_or(RunnerError::CanonicalJson)?;
                match esc {
                    b'"' | b'\\' | b'/' => out.push(esc as char),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000c}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let hex = bytes.get(i + 1..i + 5).ok_or(RunnerError::CanonicalJson)?;
                        let text = std::str::from_utf8(hex).map_err(|_| RunnerError::CanonicalJson)?;
                        let code = u32::from_str_radix(text, 16).map_err(|_| RunnerError::CanonicalJson)?;
                        out.push(char::from_u32(code).ok_or(RunnerError::CanonicalJson)?);
                        i += 4;
                    }
                    _ => return Err(RunnerError::CanonicalJson),
                }
                i += 1;
            }
            c if c < 0x20 => return Err(RunnerError::CanonicalJson),
            _ => {
                let width = utf8_char_width(b).ok_or(RunnerError::CanonicalJson)?;
                let slice = bytes.get(i..i + width).ok_or(RunnerError::CanonicalJson)?;
                let ch = std::str::from_utf8(slice)
                    .map_err(|_| RunnerError::CanonicalJson)?
                    .chars()
                    .next()
                    .ok_or(RunnerError::CanonicalJson)?;
                out.push(ch);
                i += width;
            }
        }
    }
    Err(RunnerError::CanonicalJson)
}

fn parse_number(bytes: &[u8], mut i: usize) -> Result<(usize, ()), RunnerError> {
    if bytes.get(i) == Some(&b'-') {
        i += 1;
    }
    match bytes.get(i) {
        Some(&b'0') => i += 1,
        Some(b'1'..=b'9') => {
            i += 1;
            while matches!(bytes.get(i), Some(b'0'..=b'9')) {
                i += 1;
            }
        }
        _ => return Err(RunnerError::CanonicalJson),
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        if !matches!(bytes.get(i), Some(b'0'..=b'9')) {
            return Err(RunnerError::CanonicalJson);
        }
        while matches!(bytes.get(i), Some(b'0'..=b'9')) {
            i += 1;
        }
    }
    if matches!(bytes.get(i), Some(&b'e' | &b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(&b'+' | &b'-')) {
            i += 1;
        }
        if !matches!(bytes.get(i), Some(b'0'..=b'9')) {
            return Err(RunnerError::CanonicalJson);
        }
        while matches!(bytes.get(i), Some(b'0'..=b'9')) {
            i += 1;
        }
    }
    Ok((i, ()))
}

fn consume_lit(bytes: &[u8], i: usize, lit: &[u8]) -> Result<(usize, ()), RunnerError> {
    if bytes.get(i..i + lit.len()) == Some(lit) {
        Ok((i + lit.len(), ()))
    } else {
        Err(RunnerError::CanonicalJson)
    }
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while matches!(bytes.get(i), Some(&b' ' | &b'\n' | &b'\r' | &b'\t')) {
        i += 1;
    }
    i
}

fn utf8_char_width(first: u8) -> Option<usize> {
    match first {
        0x00..=0x7F => Some(1),
        0xC2..=0xDF => Some(2),
        0xE0..=0xEF => Some(3),
        0xF0..=0xF4 => Some(4),
        _ => None,
    }
}

pub struct PiHello {
    pub connection_id: String,
    pub claimed_process_id: u64,
    pub claimed_creation_time: String,
}

pub fn parse_pi_client_hello(value: &Value) -> Result<PiHello, RunnerError> {
    let obj = value.as_object().ok_or(RunnerError::Handshake("PiClientHello"))?;
    expect_keys(
        obj,
        &[
            "protocolVersion",
            "connectionId",
            "clientInstanceId",
            "clientNonce",
            "claimedProcessId",
            "claimedProcessCreationTime",
        ],
        &[],
    )?;
    if obj.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(RunnerError::Handshake("protocolVersion"));
    }
    Ok(PiHello {
        connection_id: string_field(obj, "connectionId")?,
        claimed_process_id: obj
            .get("claimedProcessId")
            .and_then(Value::as_u64)
            .filter(|n| *n >= 1)
            .ok_or(RunnerError::Handshake("claimedProcessId"))?,
        claimed_creation_time: string_field(obj, "claimedProcessCreationTime")?,
    })
}

pub struct BrokerFrameBody {
    pub connection_id: String,
    pub sequence: u64,
    pub body: Value,
}

pub fn parse_broker_frame(value: &Value) -> Result<BrokerFrameBody, RunnerError> {
    let obj = value.as_object().ok_or(RunnerError::Frame("BrokerFrame"))?;
    expect_keys(obj, &["protocolVersion", "connectionId", "sequence", "body"], &[])?;
    if obj.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(RunnerError::Frame("protocolVersion"));
    }
    Ok(BrokerFrameBody {
        connection_id: string_field(obj, "connectionId")?,
        sequence: obj
            .get("sequence")
            .and_then(Value::as_u64)
            .filter(|n| *n >= 1)
            .ok_or(RunnerError::SequenceGap)?,
        body: obj.get("body").cloned().ok_or(RunnerError::Frame("body"))?,
    })
}

pub fn expect_keys(obj: &Map<String, Value>, required: &[&str], optional: &[&str]) -> Result<(), RunnerError> {
    for key in obj.keys() {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return Err(RunnerError::Protocol("unexpected property"));
        }
    }
    for key in required {
        if !obj.contains_key(*key) {
            return Err(RunnerError::Protocol("missing property"));
        }
    }
    Ok(())
}

fn string_field(obj: &Map<String, Value>, key: &str) -> Result<String, RunnerError> {
    obj.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or(RunnerError::Protocol("string field"))
}

fn request_id_of(body: &Value) -> String {
    body.get("requestId")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

async fn handle_request(
    body: &Value,
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
) -> Result<Value, RunnerError> {
    let (request_id, method, params) = parse_broker_request(body)?;
    store.require_serving()?;
    match method.as_str() {
        "START_RUN" => start_run(&request_id, &params, store, api).await,
        "GET_RUN_STATUS" => get_run(&request_id, &params, store, api).await,
        "POLL_RUN_EVENTS" => poll_events(&request_id, &params, store, api).await,
        "OPEN_TRUSTED_VIEW" => open_trusted(&request_id, &params, store).await,
        "OPEN_APPROVAL" => open_trusted(&request_id, &params, store).await,
        "PROVIDE_INPUT" => provide_input(&request_id, &params, store, api).await,
        "REQUEST_REPAIR" => request_repair(&request_id, &params, store, api).await,
        "CANCEL_RUN" => cancel_run(&request_id, &params, store, api).await,
        "RESUME_RUN" => get_run(&request_id, &params, store, api).await,
        _ => Err(RunnerError::Protocol("unknown broker method")),
    }
}

pub fn parse_broker_request(body: &Value) -> Result<(String, String, Map<String, Value>), RunnerError> {
    let obj = body.as_object().ok_or(RunnerError::Protocol("BrokerRequest"))?;
    expect_keys(obj, &["requestId", "method", "params"], &[])?;
    let request_id = string_field(obj, "requestId")?;
    let method = string_field(obj, "method")?;
    let params = obj
        .get("params")
        .and_then(Value::as_object)
        .ok_or(RunnerError::Protocol("params"))?
        .clone();
    match method.as_str() {
        "START_RUN" => expect_keys(&params, &["workspaceAlias", "originalRequest", "attachmentHandles"], &["requestedDeploymentId"])?,
        "GET_RUN_STATUS" | "RESUME_RUN" => expect_keys(&params, &["runId"], &[])?,
        "POLL_RUN_EVENTS" => expect_keys(&params, &["runId", "afterSequence", "limit"], &[])?,
        "OPEN_TRUSTED_VIEW" => {
            expect_keys(&params, &["runId", "view"], &[])?;
            match string_field(&params, "view")?.as_str() {
                "CONTEXT" | "DIFF" | "VERIFICATION" | "ARTIFACTS" | "EXPORT" => {}
                _ => return Err(RunnerError::Protocol("view")),
            }
        }
        "OPEN_APPROVAL" => {
            expect_keys(&params, &["action", "subjectObjectDigest"], &["runId"])?;
            match string_field(&params, "action")?.as_str() {
                "cloud-egress" | "command" | "workspace-promotion" | "project-trust"
                | "project-policy" | "workspace-registration" => {}
                _ => return Err(RunnerError::Protocol("action")),
            }
        }
        "PROVIDE_INPUT" => expect_keys(&params, &["runId", "expectedStateVersion", "questionId", "answer"], &[])?,
        "REQUEST_REPAIR" => expect_keys(&params, &["runId", "expectedStateVersion", "verdictReportObjectDigest"], &[])?,
        "CANCEL_RUN" => expect_keys(&params, &["runId", "expectedStateVersion", "reason"], &[])?,
        _ => return Err(RunnerError::Protocol("unknown broker method")),
    }
    Ok((request_id, method, params))
}

fn expected_if_match(params: &Map<String, Value>) -> Result<String, RunnerError> {
    let version = params
        .get("expectedStateVersion")
        .and_then(Value::as_u64)
        .ok_or(RunnerError::Protocol("expectedStateVersion"))?;
    Ok(quoted_state_version(version))
}

async fn start_run(
    request_id: &str,
    params: &Map<String, Value>,
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
) -> Result<Value, RunnerError> {
    reject_host_leak(params)?;
    let alias = string_field(params, "workspaceAlias")?;
    let original = string_field(params, "originalRequest")?;
    let Some((workspace_id, project_id, recovery)) = store.lookup_workspace(&alias)? else {
        return Err(RunnerError::NotFound);
    };
    if recovery != "READY" {
        return Err(RunnerError::Reconciling);
    }
    let api = api.ok_or(RunnerError::Identity("control-plane identity is not enrolled"))?;
    let run_id = new_prefixed_id("run_")?;
    let created = timestamp_now()?;
    let digest = sha256_digest_tagged(original.as_bytes());
    let mut task = serde_json::json!({
        "schemaVersion": 1,
        "runId": run_id,
        "originalRequest": original,
        "originalRequestDigest": digest,
        "userScope": {
            "allowedPathGlobs": [],
            "forbiddenPathGlobs": [],
            "forbiddenOperations": []
        },
        "attachments": [],
        "requestedVerificationCommands": [],
        "createdAt": created
    });
    if let Some(dep) = params.get("requestedDeploymentId") {
        task["requestedDeploymentId"] = dep.clone();
    }
    let body = serde_json::json!({
        "schemaVersion": 1,
        "workspaceId": workspace_id,
        "task": task
    });
    let op = new_prefixed_id("op_")?;
    let http = api.create_run(store, &op, &project_id, &run_id, &body).await?;
    eprintln!(
        "createRun status={} run_id={} project_id={} workspace_id={} body={}",
        http.status,
        run_id,
        project_id,
        workspace_id,
        String::from_utf8_lossy(&http.body)
    );
    store.bind_run(&run_id, &project_id, &workspace_id)?;
    projection_response(request_id, "RUN", "run", http)
}

async fn get_run(
    request_id: &str,
    params: &Map<String, Value>,
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
) -> Result<Value, RunnerError> {
    reject_host_leak(params)?;
    let run_id = string_field(params, "runId")?;
    let Some((project_id, _)) = store.lookup_run(&run_id)? else {
        return Err(RunnerError::NotFound);
    };
    let api = api.ok_or(RunnerError::Identity("control-plane identity is not enrolled"))?;
    let http = api.get_run(store, &project_id, &run_id).await?;
    projection_response(request_id, "RUN", "run", http)
}

async fn poll_events(
    request_id: &str,
    params: &Map<String, Value>,
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
) -> Result<Value, RunnerError> {
    reject_host_leak(params)?;
    let run_id = string_field(params, "runId")?;
    let after = params
        .get("afterSequence")
        .and_then(Value::as_u64)
        .ok_or(RunnerError::Protocol("afterSequence"))?;
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .ok_or(RunnerError::Protocol("limit"))?;
    let Some((project_id, _)) = store.lookup_run(&run_id)? else {
        return Err(RunnerError::NotFound);
    };
    let api = api.ok_or(RunnerError::Identity("control-plane identity is not enrolled"))?;
    let http = api
        .list_run_events(store, &project_id, &run_id, after, limit)
        .await?;
    projection_response(request_id, "EVENTS", "page", http)
}

async fn open_trusted(
    request_id: &str,
    params: &Map<String, Value>,
    store: &Arc<LocalStore>,
) -> Result<Value, RunnerError> {
    reject_host_leak(params)?;
    let subject = if params.contains_key("action") {
        string_field(params, "subjectObjectDigest")?
    } else {
        let run = string_field(params, "runId")?;
        let view = string_field(params, "view")?;
        sha256_digest_tagged(format!("{run}:{view}").as_bytes())
    };
    let challenge = sha256_digest_tagged(canonical_json(&Value::Object(params.clone()))?.as_slice());
    let expires = unix_millis_to_rfc3339(unix_millis_now()? + 600_000);
    let (session, nonce) = store.open_trusted_session(&challenge, &subject, &expires)?;
    Ok(serde_json::json!({
        "requestId": request_id,
        "outcome": "TRUSTED_UI_OPENED",
        "trustedUiSessionId": session,
        "nonce": nonce
    }))
}

async fn provide_input(
    request_id: &str,
    params: &Map<String, Value>,
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
) -> Result<Value, RunnerError> {
    reject_host_leak(params)?;
    let run_id = string_field(params, "runId")?;
    let question = string_field(params, "questionId")?;
    let answer = string_field(params, "answer")?;
    let if_match = expected_if_match(params)?;
    let Some((project_id, _)) = store.lookup_run(&run_id)? else {
        return Err(RunnerError::NotFound);
    };
    let api = api.ok_or(RunnerError::Identity("control-plane identity is not enrolled"))?;
    let op = new_prefixed_id("op_")?;
    let http = api
        .provide_input(store, &op, &project_id, &run_id, &question, &answer, &if_match)
        .await?;
    projection_response(request_id, "OPERATION_ACCEPTED", "operation", http)
}

async fn request_repair(
    request_id: &str,
    params: &Map<String, Value>,
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
) -> Result<Value, RunnerError> {
    reject_host_leak(params)?;
    let run_id = string_field(params, "runId")?;
    let verdict = string_field(params, "verdictReportObjectDigest")?;
    let if_match = expected_if_match(params)?;
    let Some((project_id, _)) = store.lookup_run(&run_id)? else {
        return Err(RunnerError::NotFound);
    };
    let api = api.ok_or(RunnerError::Identity("control-plane identity is not enrolled"))?;
    let op = new_prefixed_id("op_")?;
    let http = api
        .request_repair(store, &op, &project_id, &run_id, &verdict, &if_match)
        .await?;
    projection_response(request_id, "OPERATION_ACCEPTED", "operation", http)
}

async fn cancel_run(
    request_id: &str,
    params: &Map<String, Value>,
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
) -> Result<Value, RunnerError> {
    reject_host_leak(params)?;
    let run_id = string_field(params, "runId")?;
    let reason = string_field(params, "reason")?;
    let if_match = expected_if_match(params)?;
    let Some((project_id, _)) = store.lookup_run(&run_id)? else {
        return Err(RunnerError::NotFound);
    };
    let api = api.ok_or(RunnerError::Identity("control-plane identity is not enrolled"))?;
    let op = new_prefixed_id("op_")?;
    let http = api
        .cancel_run(store, &op, &project_id, &run_id, &reason, &if_match)
        .await?;
    projection_response(request_id, "OPERATION_ACCEPTED", "operation", http)
}

fn projection_response(
    request_id: &str,
    outcome: &str,
    field: &str,
    http: HttpResponse,
) -> Result<Value, RunnerError> {
    if http.status >= 400 {
        let err: Value = serde_json::from_slice(&http.body).unwrap_or_else(|_| {
            serde_json::json!({
                "schemaVersion": 1,
                "code": "INTERNAL",
                "message": "control-plane error",
                "retryClass": "ambiguous"
            })
        });
        return Ok(serde_json::json!({
            "requestId": request_id,
            "outcome": "ERROR",
            "error": err
        }));
    }
    let payload: Value =
        serde_json::from_slice(&http.body).map_err(|_| RunnerError::CanonicalJson)?;
    Ok(serde_json::json!({
        "requestId": request_id,
        "outcome": outcome,
        field: payload
    }))
}

fn reject_host_leak(params: &Map<String, Value>) -> Result<(), RunnerError> {
    for key in params.keys() {
        let lower = key.to_ascii_lowercase();
        if lower.contains("path") || (lower.contains("handle") && key != "attachmentHandles") {
            return Err(RunnerError::Protocol("native handle or host path is forbidden"));
        }
    }
    Ok(())
}

fn error_response(request_id: String, error: RunnerError) -> Value {
    let (code, retry, message) = match error {
        RunnerError::NotFound => ("NOT_FOUND", "never", "not found"),
        RunnerError::Reconciling => ("WORKSPACE_RECOVERY_REQUIRED", "after-user-action", "workspace is RECONCILING"),
        RunnerError::Conflict => ("OPERATION_ID_REUSED", "never", "operation digest conflict"),
        RunnerError::CanonicalJson
        | RunnerError::DuplicateJsonKey
        | RunnerError::Protocol(_)
        | RunnerError::Frame(_) => ("SCHEMA_INVALID", "never", "invalid broker frame"),
        RunnerError::Identity(_) => ("AUTHENTICATION_FAILED", "after-user-action", "identity required"),
        _ => ("INTERNAL", "ambiguous", "broker error"),
    };
    serde_json::json!({
        "requestId": request_id,
        "outcome": "ERROR",
        "error": {
            "schemaVersion": 1,
            "code": code,
            "message": message,
            "retryClass": retry
        }
    })
}

pub fn ensure_registered_workspace(
    store: &LocalStore,
    workspace_id: &str,
    project_id: &str,
    root_path: &str,
    volume_identity: &str,
    root_file_identity: &str,
) -> Result<(), RunnerError> {
    if store.lookup_workspace(workspace_id)?.is_some() {
        return Ok(());
    }
    store.register_workspace(
        workspace_id,
        project_id,
        root_path,
        volume_identity,
        root_file_identity,
    )
}

pub fn bootstrap_workspace_from_env(store: &LocalStore) -> Result<(), RunnerError> {
    let Ok(workspace_id) = std::env::var("PI_HEC_WORKSPACE_ID") else {
        return Ok(());
    };
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Ok(());
    }
    let project_id = std::env::var("PI_HEC_PROJECT_ID").map_err(|_| {
        RunnerError::InvalidConfig("PI_HEC_PROJECT_ID is required when PI_HEC_WORKSPACE_ID is set")
    })?;
    let root_path = std::env::var("PI_HEC_WORKSPACE_ROOT").map_err(|_| {
        RunnerError::InvalidConfig("PI_HEC_WORKSPACE_ROOT is required when PI_HEC_WORKSPACE_ID is set")
    })?;
    let volume_identity = std::env::var("PI_HEC_VOLUME_IDENTITY")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| sha256_hex(root_path.as_bytes()));
    let root_file_identity = std::env::var("PI_HEC_ROOT_FILE_IDENTITY")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| sha256_hex(workspace_id.as_bytes()));
    ensure_registered_workspace(
        store,
        workspace_id,
        project_id.trim(),
        root_path.trim(),
        &volume_identity,
        &root_file_identity,
    )
}

enum PipeWait {
    Connected,
    ChildExited,
}

async fn await_pipe_client(
    server: &mut NamedPipeServer,
    child: &ConfinedChild,
) -> Result<PipeWait, RunnerError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    loop {
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remain.is_zero() {
            return Err(RunnerError::Launch("confined Pi did not connect"));
        }
        let slice = remain.min(Duration::from_millis(500));
        match tokio::time::timeout(slice, server.connect()).await {
            Ok(result) => {
                result.map_err(RunnerError::from)?;
                return Ok(PipeWait::Connected);
            }
            Err(_) => {
                let code = child.exit_code()?;
                if code != STILL_ACTIVE {
                    eprintln!("confined Pi exit_code={code}");
                    return Ok(PipeWait::ChildExited);
                }
            }
        }
    }
}

pub fn launch_pi(config: &RunnerConfig, job: &BrokerJob) -> Result<ConfinedChild, RunnerError> {
    launch_confined(
        job,
        &config.pi_executable,
        &config.pi_args,
        config.pi_stdio_log.as_deref(),
    )
}

async fn launch_pi_blocking(config: &RunnerConfig, job: Arc<BrokerJob>) -> Result<ConfinedChild, RunnerError> {
    let exe = config.pi_executable.clone();
    let args = config.pi_args.clone();
    let stdio_log = config.pi_stdio_log.clone();
    tokio::task::spawn_blocking(move || {
        launch_confined(job.as_ref(), &exe, &args, stdio_log.as_deref())
    })
    .await
    .map_err(|_| RunnerError::Launch("launch join"))?
}

pub async fn handshake_connected_pipe(
    pipe: &mut NamedPipeServer,
    store: Arc<LocalStore>,
    job: Arc<BrokerJob>,
    api: Option<ApiClient>,
    instance_id: String,
    config: RunnerConfig,
) -> Result<(), RunnerError> {
    PipeListener { config, store, job, api, instance_id }.handle_connection(pipe).await
}
