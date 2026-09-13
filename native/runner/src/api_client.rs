#![allow(clippy::too_many_arguments)]
#![allow(clippy::collapsible_if)]
#![allow(clippy::useless_conversion)]

use crate::config::{
    canonical_json, nonce_256, parse_http_response, parse_stored_response, serialize_stored_response,
    unix_millis_now, unix_millis_to_rfc3339, DEFAULT_MUTATION_LIFETIME_SECONDS, MUTATION_PROFILE_TAG,
    MUTATION_SIGNATURE_COMPONENTS, SIGNATURE_LABEL, RunnerError,
};
use crate::local_store::{LocalStore, MutationPrepare};
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::{ClientConfig, RootCertStore};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use zeroize::Zeroize;

pub use crate::config::HttpResponse;

#[derive(Clone)]
pub struct ApiClient {
    connector: TlsConnector,
    authority: String,
    scheme_host: String,
    key_id: String,
    signing_key: SigningKey,
}

impl ApiClient {
    pub fn from_store(store: &LocalStore, control_base_url: &str, key_id: &str) -> Result<Self, RunnerError> {
        let cert_pem = store
            .get_metadata(crate::config::META_MTLS_CERT)?
            .ok_or(RunnerError::Identity("missing mTLS certificate"))?;
        let mut key_pem = store.load_secret(crate::config::META_MTLS_KEY)?;
        let ca_pem = store
            .get_metadata(crate::config::META_CA_CERT)?
            .ok_or(RunnerError::Identity("missing control-plane CA"))?;
        let mut secret = store.load_ed25519_secret()?;
        let client = Self::new(control_base_url, key_id, &cert_pem, &key_pem, &ca_pem, &secret)?;
        key_pem.zeroize();
        secret.zeroize();
        Ok(client)
    }

    pub fn new(
        control_base_url: &str,
        key_id: &str,
        client_cert_pem: &[u8],
        client_key_pem: &[u8],
        ca_pem: &[u8],
        ed25519_secret: &[u8; 32],
    ) -> Result<Self, RunnerError> {
        let url = control_base_url.trim_end_matches('/');
        let without = url
            .strip_prefix("https://")
            .ok_or(RunnerError::InvalidConfig("control URL must be https"))?;
        let authority = without.to_ascii_lowercase();
        let scheme_host = format!("https://{authority}");
        let config = mtls_config(client_cert_pem, client_key_pem, ca_pem)?;
        Ok(Self {
            connector: TlsConnector::from(Arc::new(config)),
            authority,
            scheme_host,
            key_id: key_id.to_string(),
            signing_key: SigningKey::from_bytes(ed25519_secret),
        })
    }

    pub async fn call(
        &self,
        store: &LocalStore,
        operation_id: &str,
        project_id: Option<&str>,
        method: &str,
        http_method: &str,
        path: &str,
        content_type: &str,
        body: &[u8],
        extra_headers: &[(&str, &str)],
        signed: bool,
    ) -> Result<HttpResponse, RunnerError> {
        let target_uri = format!("{}{path}", self.scheme_host);
        if signed {
            match store.prepare_mutation(operation_id, project_id, method, &target_uri, body)? {
                MutationPrepare::ResumeCompleted { response, .. } => {
                    return parse_stored_response(&response);
                }
                MutationPrepare::OutcomeUnknown { .. } => {
                    return Err(RunnerError::Protocol(
                        "in-flight mutation outcome is unknown; not sending a different body",
                    ));
                }
                MutationPrepare::Send { .. } => {}
            }
            store.mark_in_flight(operation_id)?;
        }
        let mut headers = Vec::new();
        if signed {
            headers.extend(self.signed_headers(http_method, &target_uri, content_type, body, operation_id, extra_headers)?);
        } else {
            if !body.is_empty() {
                headers.push(("content-type".into(), content_type.into()));
                headers.push(("content-length".into(), body.len().to_string()));
            }
            for (name, value) in extra_headers {
                headers.push(((*name).to_string(), (*value).to_string()));
            }
        }
        let result = self.roundtrip(http_method, path, &headers, body).await;
        if signed {
            match &result {
                Ok(response) => {
                    let stored = serialize_stored_response(response)?;
                    if let Err(error) = store.mark_completed(operation_id, &stored) {
                        store.mark_outcome_unknown(operation_id)?;
                        return Err(error);
                    }
                }
                Err(_) => {
                    store.mark_outcome_unknown(operation_id)?;
                }
            }
        }
        result
    }

    pub async fn lease_runner_job(
        &self,
        store: &LocalStore,
        operation_id: &str,
        runner_id: &str,
        capabilities_digest: &str,
    ) -> Result<HttpResponse, RunnerError> {
        let body = serde_json::json!({
            "schemaVersion": 1,
            "runnerId": runner_id,
            "capabilitiesObjectDigest": capabilities_digest,
            "maxJobs": 1
        });
        let bytes = canonical_json(&body)?;
        self.call(
            store,
            operation_id,
            None,
            "leaseRunnerJob",
            "POST",
            "/v1/runner/jobs:lease",
            "application/json",
            &bytes,
            &[],
            true,
        )
        .await
    }

    pub async fn heartbeat_operation(
        &self,
        store: &LocalStore,
        operation_id: &str,
        project_id: &str,
        target_operation_id: &str,
        lease_token: &str,
        lease_generation: u64,
        observed_input: &str,
    ) -> Result<HttpResponse, RunnerError> {
        let body = serde_json::json!({
            "schemaVersion": 1,
            "leaseToken": lease_token,
            "leaseGeneration": lease_generation,
            "observedInputObjectDigest": observed_input
        });
        let bytes = canonical_json(&body)?;
        let path = format!(
            "/v1/projects/{}/operations/{}:heartbeat",
            percent_encode(project_id),
            percent_encode(target_operation_id)
        );
        self.call(
            store,
            operation_id,
            Some(project_id),
            "heartbeatOperation",
            "POST",
            &path,
            "application/json",
            &bytes,
            &[],
            true,
        )
        .await
    }

    pub async fn complete_operation(
        &self,
        store: &LocalStore,
        operation_id: &str,
        project_id: &str,
        target_operation_id: &str,
        body: &serde_json::Value,
    ) -> Result<HttpResponse, RunnerError> {
        let bytes = canonical_json(body)?;
        let path = format!(
            "/v1/projects/{}/operations/{}/result",
            percent_encode(project_id),
            percent_encode(target_operation_id)
        );
        self.call(
            store,
            operation_id,
            Some(project_id),
            "completeOperation",
            "PUT",
            &path,
            "application/json",
            &bytes,
            &[],
            true,
        )
        .await
    }

    pub async fn missing_blobs(
        &self,
        store: &LocalStore,
        project_id: &str,
        digests: &[String],
    ) -> Result<HttpResponse, RunnerError> {
        let body = serde_json::json!({
            "schemaVersion": 1,
            "objectDigests": digests
        });
        let bytes = canonical_json(&body)?;
        let path = format!("/v1/projects/{}/blobs:missing", percent_encode(project_id));
        self.call(
            store,
            "",
            Some(project_id),
            "missingBlobs",
            "POST",
            &path,
            "application/json",
            &bytes,
            &[],
            false,
        )
        .await
    }

    pub async fn put_blob(
        &self,
        store: &LocalStore,
        operation_id: &str,
        project_id: &str,
        object_digest: &str,
        bytes: &[u8],
    ) -> Result<HttpResponse, RunnerError> {
        let path = format!(
            "/v1/projects/{}/blobs/sha256/{}",
            percent_encode(project_id),
            percent_encode(object_digest)
        );
        self.call(
            store,
            operation_id,
            Some(project_id),
            "putBlob",
            "PUT",
            &path,
            "application/octet-stream",
            bytes,
            &[],
            true,
        )
        .await
    }

    pub async fn create_run(
        &self,
        store: &LocalStore,
        operation_id: &str,
        project_id: &str,
        run_id: &str,
        body: &serde_json::Value,
    ) -> Result<HttpResponse, RunnerError> {
        let bytes = canonical_json(body)?;
        let path = format!(
            "/v1/projects/{}/runs/{}",
            percent_encode(project_id),
            percent_encode(run_id)
        );
        self.call(
            store,
            operation_id,
            Some(project_id),
            "createRun",
            "PUT",
            &path,
            "application/json",
            &bytes,
            &[],
            true,
        )
        .await
    }

    pub async fn get_run(
        &self,
        store: &LocalStore,
        project_id: &str,
        run_id: &str,
    ) -> Result<HttpResponse, RunnerError> {
        let path = format!(
            "/v1/projects/{}/runs/{}",
            percent_encode(project_id),
            percent_encode(run_id)
        );
        self.call(
            store,
            "",
            Some(project_id),
            "getRun",
            "GET",
            &path,
            "application/json",
            &[],
            &[],
            false,
        )
        .await
    }

    pub async fn list_run_agents(
        &self,
        store: &LocalStore,
        project_id: &str,
        run_id: &str,
    ) -> Result<HttpResponse, RunnerError> {
        let path = format!(
            "/v1/projects/{}/runs/{}/agents",
            percent_encode(project_id),
            percent_encode(run_id)
        );
        self.call(
            store,
            "",
            Some(project_id),
            "listRunAgents",
            "GET",
            &path,
            "application/json",
            &[],
            &[],
            false,
        )
        .await
    }

    pub async fn list_run_events(
        &self,
        store: &LocalStore,
        project_id: &str,
        run_id: &str,
        after: u64,
        limit: u64,
    ) -> Result<HttpResponse, RunnerError> {
        let path = format!(
            "/v1/projects/{}/runs/{}/events?after={after}&limit={limit}",
            percent_encode(project_id),
            percent_encode(run_id)
        );
        self.call(
            store,
            "",
            Some(project_id),
            "listRunEvents",
            "GET",
            &path,
            "application/json",
            &[],
            &[],
            false,
        )
        .await
    }

    pub async fn provide_input(
        &self,
        store: &LocalStore,
        operation_id: &str,
        project_id: &str,
        run_id: &str,
        question_id: &str,
        answer: &str,
        if_match: &str,
    ) -> Result<HttpResponse, RunnerError> {
        let body = serde_json::json!({
            "schemaVersion": 1,
            "questionId": question_id,
            "answer": answer,
            "source": "user"
        });
        let bytes = canonical_json(&body)?;
        let path = format!(
            "/v1/projects/{}/runs/{}:provide-input",
            percent_encode(project_id),
            percent_encode(run_id)
        );
        self.call(
            store,
            operation_id,
            Some(project_id),
            "provideRunInput",
            "POST",
            &path,
            "application/json",
            &bytes,
            &[("if-match", if_match)],
            true,
        )
        .await
    }

    pub async fn request_repair(
        &self,
        store: &LocalStore,
        operation_id: &str,
        project_id: &str,
        run_id: &str,
        verdict_digest: &str,
        if_match: &str,
    ) -> Result<HttpResponse, RunnerError> {
        let body = serde_json::json!({
            "schemaVersion": 1,
            "verdictReportObjectDigest": verdict_digest
        });
        let bytes = canonical_json(&body)?;
        let path = format!(
            "/v1/projects/{}/runs/{}:request-repair",
            percent_encode(project_id),
            percent_encode(run_id)
        );
        self.call(
            store,
            operation_id,
            Some(project_id),
            "requestRunRepair",
            "POST",
            &path,
            "application/json",
            &bytes,
            &[("if-match", if_match)],
            true,
        )
        .await
    }

    pub async fn cancel_run(
        &self,
        store: &LocalStore,
        operation_id: &str,
        project_id: &str,
        run_id: &str,
        reason: &str,
        if_match: &str,
    ) -> Result<HttpResponse, RunnerError> {
        let body = serde_json::json!({
            "schemaVersion": 1,
            "reason": reason
        });
        let bytes = canonical_json(&body)?;
        let path = format!(
            "/v1/projects/{}/runs/{}:cancel",
            percent_encode(project_id),
            percent_encode(run_id)
        );
        self.call(
            store,
            operation_id,
            Some(project_id),
            "cancelRun",
            "POST",
            &path,
            "application/json",
            &bytes,
            &[("if-match", if_match)],
            true,
        )
        .await
    }

    fn signed_headers(
        &self,
        method: &str,
        target_uri: &str,
        content_type: &str,
        body: &[u8],
        operation_id: &str,
        extra: &[(&str, &str)],
    ) -> Result<Vec<(String, String)>, RunnerError> {
        let created = (unix_millis_now()? / 1000) as i64;
        let expires = created + DEFAULT_MUTATION_LIFETIME_SECONDS;
        let issued_at = unix_millis_to_rfc3339((created as u64) * 1000);
        let expires_at = unix_millis_to_rfc3339((expires as u64) * 1000);
        let nonce = nonce_256()?;
        let mut headers = vec![
            ("content-type".into(), content_type.to_string()),
            ("content-length".into(), body.len().to_string()),
            ("content-digest".into(), content_digest_sha256(body)),
            ("operation-id".into(), operation_id.to_string()),
            ("x-hec-issued-at".into(), issued_at),
            ("x-hec-expires-at".into(), expires_at),
            ("x-hec-nonce".into(), nonce.clone()),
        ];
        for (name, value) in extra {
            headers.push(((*name).to_string(), (*value).to_string()));
        }
        let mut covered: Vec<&str> = MUTATION_SIGNATURE_COMPONENTS.to_vec();
        if header_value(&headers, "if-match").is_some() {
            covered.push("if-match");
        }
        if header_value(&headers, "content-range").is_some() {
            covered.push("content-range");
        }
        let params = signature_params_inner(&covered, created, expires, &nonce, &self.key_id);
        let mut base = String::new();
        for component in &covered {
            let value = component_value(component, method, &self.authority, target_uri, &headers)?;
            base.push('"');
            base.push_str(component);
            base.push_str("\": ");
            base.push_str(&value);
            base.push('\n');
        }
        base.push_str("\"@signature-params\": ");
        base.push_str(&params);
        let signature = self.signing_key.sign(base.as_bytes());
        headers.push((
            "signature-input".into(),
            format!("{SIGNATURE_LABEL}={params}"),
        ));
        headers.push((
            "signature".into(),
            format!(
                "{SIGNATURE_LABEL}={}",
                sf_byte_sequence(&signature.to_bytes())
            ),
        ));
        Ok(headers)
    }

    async fn roundtrip(
        &self,
        method: &str,
        path: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Result<HttpResponse, RunnerError> {
        let (host, port) = split_authority(&self.authority)?;
        let stream = TcpStream::connect((host.as_str(), port)).await?;
        stream.set_nodelay(true)?;
        let server_name = ServerName::try_from(host.clone())
            .map_err(|_| RunnerError::Http("invalid TLS server name"))?;
        let mut tls = self
            .connector
            .connect(server_name, stream)
            .await
            .map_err(|_| RunnerError::Http("TLS handshake failed"))?;
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n", self.authority);
        for (name, value) in headers {
            request.push_str(name);
            request.push_str(": ");
            request.push_str(value);
            request.push_str("\r\n");
        }
        request.push_str("\r\n");
        tls.write_all(request.as_bytes()).await?;
        if !body.is_empty() {
            tls.write_all(body).await?;
        }
        tls.flush().await?;
        let mut raw = Vec::new();
        tls.read_to_end(&mut raw).await?;
        parse_http_response(&raw)
    }
}

pub fn content_digest_sha256(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    format!(
        "sha-256=:{}:",
        base64::engine::general_purpose::STANDARD.encode(digest)
    )
}

fn mtls_config(
    client_cert_pem: &[u8],
    client_key_pem: &[u8],
    ca_pem: &[u8],
) -> Result<ClientConfig, RunnerError> {
    let mut roots = RootCertStore::empty();
    let ca_certs = rustls_pemfile::certs(&mut Cursor::new(ca_pem))
        .collect::<Result<Vec<CertificateDer<'static>>, _>>()
        .map_err(|_| RunnerError::Identity("CA PEM"))?;
    for cert in ca_certs {
        roots
            .add(cert)
            .map_err(|_| RunnerError::Identity("CA trust anchor"))?;
    }
    let certs = rustls_pemfile::certs(&mut Cursor::new(client_cert_pem))
        .collect::<Result<Vec<CertificateDer<'static>>, _>>()
        .map_err(|_| RunnerError::Identity("client cert PEM"))?;
    let key = rustls_pemfile::private_key(&mut Cursor::new(client_key_pem))
        .map_err(|_| RunnerError::Identity("client key PEM"))?
        .ok_or(RunnerError::Identity("client key PEM missing"))?;
    let provider = rustls::crypto::ring::default_provider();
    let mut config = ClientConfig::builder_with_provider(provider.into())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| RunnerError::Identity("TLS 1.3 provider"))?
        .with_root_certificates(roots)
        .with_client_auth_cert(certs, PrivateKeyDer::from(key))
        .map_err(|_| RunnerError::Identity("client auth certificate"))?;
    config.enable_early_data = false;
    config.alpn_protocols.clear();
    Ok(config)
}

fn sf_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn sf_byte_sequence(bytes: &[u8]) -> String {
    format!(":{}:", base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub fn signature_params_inner(
    covered: &[&str],
    created: i64,
    expires: i64,
    nonce: &str,
    key_id: &str,
) -> String {
    let list = covered
        .iter()
        .map(|component| sf_string(component))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "({list});created={created};expires={expires};nonce={};keyid={};alg={};tag={}",
        sf_string(nonce),
        sf_string(key_id),
        sf_string("ed25519"),
        sf_string(MUTATION_PROFILE_TAG)
    )
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn component_value(
    component: &str,
    method: &str,
    authority: &str,
    target_uri: &str,
    headers: &[(String, String)],
) -> Result<String, RunnerError> {
    match component {
        "@method" => Ok(method.to_ascii_uppercase()),
        "@authority" => Ok(authority.to_string()),
        "@target-uri" => Ok(target_uri.to_string()),
        _ => header_value(headers, component)
            .map(str::to_string)
            .ok_or(RunnerError::Http("missing covered component")),
    }
}

fn split_authority(authority: &str) -> Result<(String, u16), RunnerError> {
    if let Some((host, port)) = authority.rsplit_once(':') {
        if !host.starts_with('[') && port.chars().all(|c| c.is_ascii_digit()) {
            let parsed = port.parse::<u16>().map_err(|_| RunnerError::Http("port"))?;
            return Ok((host.to_string(), parsed));
        }
    }
    Ok((authority.to_string(), 443))
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    out
}

pub async fn claim_loop(
    client: ApiClient,
    store: std::sync::Arc<LocalStore>,
    runner_id: String,
    capabilities_digest: String,
) -> Result<(), RunnerError> {
    loop {
        let op = crate::config::new_prefixed_id("op_")?;
        match client
            .lease_runner_job(&store, &op, &runner_id, &capabilities_digest)
            .await
        {
            Ok(http) if http.status == 200 => {
                let value: serde_json::Value =
                    serde_json::from_slice(&http.body).map_err(|_| RunnerError::CanonicalJson)?;
                match value.get("outcome").and_then(|v| v.as_str()) {
                    Some("NO_JOB") => {
                        let retry = value
                            .get("retryAfterMs")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(1_000);
                        tokio::time::sleep(Duration::from_millis(retry.max(50))).await;
                    }
                    Some("LEASED") => {
                        let _ = settle_leased_job(&client, &store, &value).await;
                    }
                    _ => tokio::time::sleep(Duration::from_millis(1_000)).await,
                }
            }
            _ => tokio::time::sleep(Duration::from_millis(1_000)).await,
        }
    }
}

async fn settle_leased_job(
    client: &ApiClient,
    store: &LocalStore,
    lease: &serde_json::Value,
) -> Result<(), RunnerError> {
    let project_id = lease
        .get("projectId")
        .and_then(|v| v.as_str())
        .ok_or(RunnerError::Protocol("lease projectId"))?;
    let operation_id = lease
        .get("operationId")
        .and_then(|v| v.as_str())
        .ok_or(RunnerError::Protocol("lease operationId"))?;
    let token = lease
        .get("leaseToken")
        .and_then(|v| v.as_str())
        .ok_or(RunnerError::Protocol("lease token"))?;
    let generation = lease
        .get("leaseGeneration")
        .and_then(|v| v.as_u64())
        .ok_or(RunnerError::Protocol("lease generation"))?;
    let input = lease
        .get("inputObjectDigest")
        .and_then(|v| v.as_str())
        .ok_or(RunnerError::Protocol("lease input digest"))?;
    let hb_op = crate::config::new_prefixed_id("op_")?;
    let heartbeat = client
        .heartbeat_operation(store, &hb_op, project_id, operation_id, token, generation, input)
        .await;
    let cancelled = heartbeat
        .as_ref()
        .ok()
        .filter(|http| http.status == 200)
        .and_then(|http| serde_json::from_slice::<serde_json::Value>(&http.body).ok())
        .and_then(|value| value.get("cancellationRequested").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    if heartbeat.as_ref().map(|http| http.status).unwrap_or(0) != 200 {
        return Ok(());
    }
    let message = if cancelled {
        "lease cancelled before host executor"
    } else {
        "no host snapshot or sandbox executor for leased operation"
    };
    let error = serde_json::json!({
        "schemaVersion": 1,
        "code": "INTERNAL",
        "message": message,
        "retryClass": "after-user-action"
    });
    let bytes = canonical_json(&error)?;
    let digest = crate::config::sha256_digest_tagged(&bytes);
    let put_op = crate::config::new_prefixed_id("op_")?;
    let put = client
        .put_blob(store, &put_op, project_id, &digest, &bytes)
        .await?;
    if put.status != 201 && put.status != 204 {
        return Ok(());
    }
    let complete_op = crate::config::new_prefixed_id("op_")?;
    let body = serde_json::json!({
        "schemaVersion": 1,
        "leaseToken": token,
        "leaseGeneration": generation,
        "outcome": "FAILED",
        "errorObjectDigest": digest
    });
    let _ = client
        .complete_operation(store, &complete_op, project_id, operation_id, &body)
        .await?;
    Ok(())
}
