#![allow(clippy::collapsible_if)]
#![allow(clippy::manual_range_contains)]

use base64::Engine;
use sha2::{Digest, Sha256};
use std::fmt::{Display, Formatter};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_FRAME_BYTES: u32 = 1_048_576;
pub const MAX_OUTSTANDING_REQUESTS: usize = 32;
pub const PIPE_NAME_PREFIX: &str = r"\\.\pipe\pi-hec-v1-";
pub const MUTATION_PROFILE_TAG: &str = "pi-hec-mutation-v1";
pub const SIGNATURE_LABEL: &str = "sig1";
pub const MAX_MUTATION_LIFETIME_SECONDS: i64 = 120;
pub const DEFAULT_MUTATION_LIFETIME_SECONDS: i64 = 60;
pub const DPAPI_KEY_ID: &str = "dpapi-current-user";
pub const META_ED25519: &str = "client_ed25519_secret";
pub const META_MTLS_KEY: &str = "client_mtls_key";
pub const META_MTLS_CERT: &str = "client_mtls_cert";
pub const META_CA_CERT: &str = "control_ca_cert";
pub const META_KEY_ID: &str = "mutation_key_id";
pub const META_RUNNER_ID: &str = "runner_id";
pub const META_CONTROL_URL: &str = "control_base_url";
pub const META_BROKER_INSTANCE: &str = "broker_instance_id";
pub const META_CAPABILITIES: &str = "capabilities_object_digest";
pub const ZERO_OBJECT_DIGEST: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
pub const MUTATION_SIGNATURE_COMPONENTS: [&str; 10] = [
    "@method",
    "@authority",
    "@target-uri",
    "content-digest",
    "content-type",
    "content-length",
    "operation-id",
    "x-hec-issued-at",
    "x-hec-expires-at",
    "x-hec-nonce",
];

#[derive(Debug)]
pub enum RunnerError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    Tls(rustls::Error),
    Protocol(&'static str),
    Handshake(&'static str),
    Frame(&'static str),
    CanonicalJson,
    DuplicateJsonKey,
    TrailingBytes,
    SequenceGap,
    OversizeFrame,
    ZeroLengthFrame,
    OutstandingLimit,
    ClaimMismatch,
    LockHeld,
    Reconciling,
    Conflict,
    NotFound,
    Dpapi,
    Identity(&'static str),
    Http(&'static str),
    Launch(&'static str),
    Random,
    InvalidConfig(&'static str),
}

impl Display for RunnerError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "io: {error}"),
            Self::Sqlite(error) => write!(f, "sqlite: {error}"),
            Self::Tls(error) => write!(f, "tls: {error}"),
            Self::Protocol(msg)
            | Self::Handshake(msg)
            | Self::Frame(msg)
            | Self::Identity(msg)
            | Self::Http(msg)
            | Self::Launch(msg)
            | Self::InvalidConfig(msg) => f.write_str(msg),
            Self::CanonicalJson => f.write_str("non-canonical JSON"),
            Self::DuplicateJsonKey => f.write_str("duplicate JSON key"),
            Self::TrailingBytes => f.write_str("trailing bytes"),
            Self::SequenceGap => f.write_str("frame sequence gap"),
            Self::OversizeFrame => f.write_str("frame exceeds 1 MiB"),
            Self::ZeroLengthFrame => f.write_str("zero-length frame"),
            Self::OutstandingLimit => f.write_str("outstanding request limit"),
            Self::ClaimMismatch => f.write_str("claimed process identity mismatch"),
            Self::LockHeld => f.write_str("exclusive workspace lock held"),
            Self::Reconciling => f.write_str("workspace is RECONCILING"),
            Self::Conflict => f.write_str("operation digest conflict"),
            Self::NotFound => f.write_str("not found"),
            Self::Dpapi => f.write_str("DPAPI protect/unprotect failed"),
            Self::Random => f.write_str("system CSPRNG failed"),
        }
    }
}

impl std::error::Error for RunnerError {}

impl From<std::io::Error> for RunnerError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<rusqlite::Error> for RunnerError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

impl From<rustls::Error> for RunnerError {
    fn from(value: rustls::Error) -> Self {
        Self::Tls(value)
    }
}

#[derive(Debug, Clone)]
pub struct RunnerConfig {
    pub data_dir: PathBuf,
    pub control_base_url: String,
    pub runner_id: String,
    pub key_id: String,
    pub pi_executable: PathBuf,
    pub pi_args: Vec<String>,
    pub pi_stdio_log: Option<PathBuf>,
    pub identity_dir: PathBuf,
    pub capabilities_path: PathBuf,
}

impl RunnerConfig {
    pub fn from_env() -> Result<Self, RunnerError> {
        let data_dir = PathBuf::from(std::env::var("PI_HEC_DATA_DIR").map_err(|_| {
            RunnerError::InvalidConfig("PI_HEC_DATA_DIR is required")
        })?);
        let identity_dir = std::env::var("PI_HEC_IDENTITY_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("identity"));
        let capabilities_path = std::env::var("PI_HEC_CAPABILITIES_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("capabilities.json"));
        Ok(Self {
            control_base_url: std::env::var("PI_HEC_CONTROL_URL").map_err(|_| {
                RunnerError::InvalidConfig("PI_HEC_CONTROL_URL is required")
            })?,
            runner_id: std::env::var("PI_HEC_RUNNER_ID")
                .map_err(|_| RunnerError::InvalidConfig("PI_HEC_RUNNER_ID is required"))?,
            key_id: std::env::var("PI_HEC_KEY_ID")
                .map_err(|_| RunnerError::InvalidConfig("PI_HEC_KEY_ID is required"))?,
            pi_executable: PathBuf::from(std::env::var("PI_HEC_PI_EXECUTABLE").map_err(|_| {
                RunnerError::InvalidConfig("PI_HEC_PI_EXECUTABLE is required")
            })?),
            pi_args: parse_pi_args(std::env::var("PI_HEC_PI_ARGS").ok().as_deref())?,
            pi_stdio_log: std::env::var("PI_HEC_PI_STDIO_LOG")
                .ok()
                .map(PathBuf::from)
                .filter(|path| !path.as_os_str().is_empty()),
            identity_dir,
            capabilities_path,
            data_dir,
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("broker.sqlite")
    }

    pub fn lock_path(&self) -> PathBuf {
        self.data_dir.join("broker.lock")
    }
}

pub fn parse_pi_args(raw: Option<&str>) -> Result<Vec<String>, RunnerError> {
    let Some(text) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };
    let parsed = serde_json::from_str::<serde_json::Value>(text).map_err(|_| {
        RunnerError::InvalidConfig("PI_HEC_PI_ARGS must be a JSON array of strings")
    })?;
    let serde_json::Value::Array(items) = parsed else {
        return Err(RunnerError::InvalidConfig(
            "PI_HEC_PI_ARGS must be a JSON array of strings",
        ));
    };
    let mut args = Vec::with_capacity(items.len());
    for item in items {
        let serde_json::Value::String(value) = item else {
            return Err(RunnerError::InvalidConfig(
                "PI_HEC_PI_ARGS must be a JSON array of strings",
            ));
        };
        args.push(value);
    }
    Ok(args)
}

pub fn unix_millis_now() -> Result<u64, RunnerError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .map_err(|_| RunnerError::InvalidConfig("system clock before unix epoch"))
}

pub fn timestamp_now() -> Result<String, RunnerError> {
    Ok(unix_millis_to_rfc3339(unix_millis_now()?))
}

pub fn unix_millis_to_rfc3339(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let (year, month, day, hour, minute, second) = civil_from_unix(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_unix(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400) as u32;
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u32;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year as i32, month, day, hour, minute, second)
}

pub fn random_bytes<const N: usize>() -> Result<[u8; N], RunnerError> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| RunnerError::Random)?;
    Ok(bytes)
}

pub fn nonce_256() -> Result<String, RunnerError> {
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        random_bytes::<32>()?,
    ))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push(HEX[(byte >> 4) as usize] as char);
        hex.push(HEX[(byte & 0x0f) as usize] as char);
    }
    hex
}

pub fn sha256_digest_tagged(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

pub fn is_object_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_zero_object_digest(value: &str) -> bool {
    value == ZERO_OBJECT_DIGEST
}

pub fn quoted_state_version(version: u64) -> String {
    format!("\"{version}\"")
}

pub fn uuid_v7_from(ms: u64, rand: [u8; 10]) -> String {
    let mut bytes = [0u8; 16];
    bytes[0] = (ms >> 40) as u8;
    bytes[1] = (ms >> 32) as u8;
    bytes[2] = (ms >> 24) as u8;
    bytes[3] = (ms >> 16) as u8;
    bytes[4] = (ms >> 8) as u8;
    bytes[5] = ms as u8;
    bytes[6] = (rand[0] & 0x0f) | 0x70;
    bytes[7] = rand[1];
    bytes[8] = (rand[2] & 0x3f) | 0x80;
    bytes[9..16].copy_from_slice(&rand[3..10]);
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

pub fn new_prefixed_id(prefix: &str) -> Result<String, RunnerError> {
    Ok(format!(
        "{prefix}{}",
        uuid_v7_from(unix_millis_now()?, random_bytes::<10>()?)
    ))
}

pub fn canonical_json(value: &serde_json::Value) -> Result<Vec<u8>, RunnerError> {
    serde_json_canonicalizer::to_vec(value).map_err(|_| RunnerError::CanonicalJson)
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub fn parse_http_response(raw: &[u8]) -> Result<HttpResponse, RunnerError> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or(RunnerError::Http("truncated HTTP response"))?;
    let header_text =
        std::str::from_utf8(&raw[..split]).map_err(|_| RunnerError::Http("headers utf8"))?;
    let rest = &raw[split + 4..];
    let mut lines = header_text.split("\r\n");
    let status_line = lines.next().ok_or(RunnerError::Http("status line"))?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or(RunnerError::Http("status code"))?;
    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let body = if let Some(len) = header_lookup(&headers, "content-length") {
        let n = len.parse::<usize>().map_err(|_| RunnerError::Http("content-length"))?;
        rest.get(..n).ok_or(RunnerError::Http("short body"))?.to_vec()
    } else if header_lookup(&headers, "transfer-encoding")
        .is_some_and(|v| v.eq_ignore_ascii_case("chunked"))
    {
        decode_chunked(rest)?
    } else {
        rest.to_vec()
    };
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

fn decode_chunked(mut rest: &[u8]) -> Result<Vec<u8>, RunnerError> {
    let mut body = Vec::new();
    loop {
        let nl = rest
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or(RunnerError::Http("chunk size"))?;
        let size_line = std::str::from_utf8(&rest[..nl]).map_err(|_| RunnerError::Http("chunk utf8"))?;
        let size = usize::from_str_radix(size_line.trim(), 16).map_err(|_| RunnerError::Http("chunk hex"))?;
        rest = &rest[nl + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size + 2 {
            return Err(RunnerError::Http("short chunk"));
        }
        body.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
    Ok(body)
}

pub fn serialize_stored_response(response: &HttpResponse) -> Result<Vec<u8>, RunnerError> {
    serde_json::to_vec(&serde_json::json!({
        "status": response.status,
        "headers": response.headers,
        "body": base64::engine::general_purpose::STANDARD.encode(&response.body)
    }))
    .map_err(|_| RunnerError::CanonicalJson)
}

pub fn parse_stored_response(bytes: &[u8]) -> Result<HttpResponse, RunnerError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| RunnerError::CanonicalJson)?;
    let status = value
        .get("status")
        .and_then(|v| v.as_u64())
        .ok_or(RunnerError::Protocol("stored response status"))? as u16;
    let body_b64 = value
        .get("body")
        .and_then(|v| v.as_str())
        .ok_or(RunnerError::Protocol("stored response body"))?;
    let body = base64::engine::general_purpose::STANDARD
        .decode(body_b64)
        .map_err(|_| RunnerError::Protocol("stored response b64"))?;
    let mut headers = Vec::new();
    if let Some(arr) = value.get("headers").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(pair) = item.as_array() {
                if let (Some(k), Some(v)) = (
                    pair.first().and_then(|x| x.as_str()),
                    pair.get(1).and_then(|x| x.as_str()),
                ) {
                    headers.push((k.to_string(), v.to_string()));
                }
            }
        }
    }
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

fn header_lookup<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::{parse_pi_args, unix_millis_to_rfc3339, uuid_v7_from};

    #[test]
    fn rfc3339_millis_is_canonical() {
        assert_eq!(unix_millis_to_rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            unix_millis_to_rfc3339(1_778_112_000_000),
            "2026-05-07T00:00:00.000Z"
        );
    }

    #[test]
    fn uuid_v7_sets_version_and_variant() {
        let id = uuid_v7_from(1_777_276_800_000, [0u8; 10]);
        let version = id.as_bytes()[14];
        assert_eq!(version, b'7');
        let variant_nibble = u8::from_str_radix(&id[19..20], 16).unwrap();
        assert!(variant_nibble >= 8 && variant_nibble <= 0xb);
    }

    #[test]
    fn if_match_is_quoted_decimal_state_version() {
        assert_eq!(super::quoted_state_version(0), "\"0\"");
        assert_eq!(super::quoted_state_version(12), "\"12\"");
        assert!(super::is_object_digest(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(super::is_zero_object_digest(super::ZERO_OBJECT_DIGEST));
        assert!(!super::is_object_digest("sha256:zz"));
    }

    #[test]
    fn pi_args_parse_json_string_array() {
        assert_eq!(parse_pi_args(None).unwrap(), Vec::<String>::new());
        assert_eq!(parse_pi_args(Some("")).unwrap(), Vec::<String>::new());
        assert_eq!(parse_pi_args(Some("   ")).unwrap(), Vec::<String>::new());
        assert_eq!(
            parse_pi_args(Some(r#"["--mode","rpc"]"#)).unwrap(),
            vec!["--mode".to_string(), "rpc".to_string()]
        );
        assert!(parse_pi_args(Some("{}")).is_err());
        assert!(parse_pi_args(Some("[1]")).is_err());
        assert!(parse_pi_args(Some("not-json")).is_err());
    }
}
