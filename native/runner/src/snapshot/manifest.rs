#![allow(clippy::too_many_arguments)]

use crate::config::{RunnerError, canonical_json, sha256_digest_tagged};
use crate::snapshot::chunker::{FileStorage, storage_json};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const SNAPSHOT_ROOT_FIELDS: &[&str] = &[
    "repositoryId",
    "workspaceId",
    "gitHead",
    "gitIndexDigest",
    "gitHistoryRootDigest",
    "dirty",
    "filesystem",
    "entries",
    "ignoredPathDigests",
    "excludedPaths",
];

const FILESYSTEM_FIELDS: &[&str] = &[
    "rootChildNameComparison",
    "unicodeNormalization",
    "unicodeSimpleFoldTableObjectDigest",
    "pathGlobDialect",
    "volumeIdentity",
];

const GIT_HISTORY_FIELDS: &[&str] = &[
    "repositoryId",
    "refs",
    "commits",
    "shallowBoundaryObjectIds",
    "replaceRefsIgnored",
];

pub fn unicode_simple_fold_table_digest() -> Result<String, RunnerError> {
    let payload = json!({
        "algorithm": "Unicode Simple_Case_Folding",
        "pathGlobDialect": "pi-hec-pathglob/v1",
        "unicodeVersion": "16.0.0"
    });
    Ok(sha256_digest_tagged(&canonical_json(&payload)?))
}

pub fn tagged_hash(domain: &str, version: u64, payload: &Value) -> Result<String, RunnerError> {
    let projected = project_payload(domain, payload)?;
    let tagged = json!({
        "domain": domain,
        "version": version,
        "payload": projected
    });
    Ok(sha256_digest_tagged(&canonical_json(&tagged)?))
}

pub fn snapshot_root_digest(payload: &Value) -> Result<String, RunnerError> {
    tagged_hash("snapshot-root", 1, payload)
}

pub fn git_history_root_digest(payload: &Value) -> Result<String, RunnerError> {
    tagged_hash("git-history-root", 1, payload)
}

pub fn hmac_ignored_path(project_metadata_key: &[u8; 32], normalized_path: &str) -> String {
    let mut msg = Vec::from(b"ignored-path\0".as_slice());
    msg.extend_from_slice(normalized_path.as_bytes());
    let mac = hmac_sha256(project_metadata_key, &msg);
    format!("sha256:{}", hex_of(&mac))
}

pub fn windows_file_entry(
    path: &str,
    content_digest: &str,
    size: u64,
    git_mode: &str,
    git_object_id: Option<&str>,
    storage: &FileStorage,
    file_id: &str,
    reparse_tag: Option<u32>,
    security_descriptor_digest: &str,
    alternate_streams: &[Value],
) -> Value {
    let mut meta = json!({
        "kind": "windows",
        "fileId": file_id,
        "securityDescriptorDigest": security_descriptor_digest,
        "alternateStreams": alternate_streams
    });
    if let Some(tag) = reparse_tag {
        meta["reparseTag"] = json!(tag);
    }
    let mut entry = json!({
        "path": path,
        "platformMetadata": meta,
        "entryType": "file",
        "contentDigest": content_digest,
        "size": size,
        "gitMode": git_mode,
        "storage": storage_json(storage)
    });
    if let Some(oid) = git_object_id {
        entry["gitObjectId"] = json!(oid);
    }
    entry
}

pub fn windows_dir_entry(
    path: &str,
    child_cmp: &str,
    file_id: &str,
    security_descriptor_digest: &str,
    alternate_streams: &[Value],
) -> Value {
    json!({
        "path": path,
        "platformMetadata": {
            "kind": "windows",
            "fileId": file_id,
            "securityDescriptorDigest": security_descriptor_digest,
            "alternateStreams": alternate_streams
        },
        "entryType": "directory",
        "childNameComparison": child_cmp
    })
}

pub fn windows_symlink_entry(
    path: &str,
    target: &str,
    file_id: &str,
    reparse_tag: u32,
    security_descriptor_digest: &str,
    alternate_streams: &[Value],
) -> Value {
    json!({
        "path": path,
        "platformMetadata": {
            "kind": "windows",
            "fileId": file_id,
            "reparseTag": reparse_tag,
            "securityDescriptorDigest": security_descriptor_digest,
            "alternateStreams": alternate_streams
        },
        "entryType": "symlink",
        "symlinkTarget": target,
        "gitMode": "120000"
    })
}

pub fn windows_submodule_entry(
    path: &str,
    git_object_id: &str,
    file_id: &str,
    security_descriptor_digest: &str,
    alternate_streams: &[Value],
) -> Value {
    json!({
        "path": path,
        "platformMetadata": {
            "kind": "windows",
            "fileId": file_id,
            "securityDescriptorDigest": security_descriptor_digest,
            "alternateStreams": alternate_streams
        },
        "entryType": "submodule",
        "gitObjectId": git_object_id,
        "gitMode": "160000"
    })
}

pub fn snapshot_root_payload(manifest: &Value) -> Value {
    let obj = manifest.as_object().cloned().unwrap_or_default();
    let mut out = Map::new();
    for field in SNAPSHOT_ROOT_FIELDS {
        if let Some(value) = obj.get(*field) {
            if *field == "filesystem" {
                out.insert(
                    (*field).to_string(),
                    project_object(value, FILESYSTEM_FIELDS),
                );
            } else {
                out.insert((*field).to_string(), value.clone());
            }
        }
    }
    Value::Object(sort_snapshot_root(out))
}

pub fn sign_envelope(
    schema_name: &str,
    payload: &Value,
    signing_key: &SigningKey,
    key_id: &str,
    cert_digest: &str,
    signed_at: &str,
) -> Result<Value, RunnerError> {
    let payload_digest = tagged_hash(
        "artifact-payload",
        1,
        &json!({
            "schemaName": schema_name,
            "schemaVersion": 1,
            "payload": payload
        }),
    )?;
    let input = tagged_hash(
        "artifact-signature-input",
        1,
        &json!({
            "schemaName": schema_name,
            "schemaVersion": 1,
            "payloadDigest": payload_digest,
            "keyId": key_id,
            "algorithm": "Ed25519",
            "signedAt": signed_at,
            "signerCertificateObjectDigest": cert_digest
        }),
    )?;
    let signature = signing_key.sign(input.as_bytes());
    Ok(json!({
        "schemaName": schema_name,
        "schemaVersion": 1,
        "payload": payload,
        "payloadDigest": payload_digest,
        "signatures": [{
            "keyId": key_id,
            "algorithm": "Ed25519",
            "signedAt": signed_at,
            "signerCertificateObjectDigest": cert_digest,
            "signature": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, signature.to_bytes())
        }]
    }))
}

pub fn verify_envelope(
    envelope: &Value,
    verifying_key: &VerifyingKey,
    expected_key_id: &str,
) -> Result<(), RunnerError> {
    let schema_name = envelope
        .get("schemaName")
        .and_then(Value::as_str)
        .ok_or(RunnerError::Protocol("envelope schemaName"))?;
    let schema_version = envelope
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or(RunnerError::Protocol("envelope schemaVersion"))?;
    let payload = envelope
        .get("payload")
        .ok_or(RunnerError::Protocol("envelope payload"))?;
    let signatures = envelope
        .get("signatures")
        .and_then(Value::as_array)
        .ok_or(RunnerError::Protocol("envelope signatures"))?;
    let first = signatures
        .first()
        .ok_or(RunnerError::Protocol("envelope signatures"))?;
    if signatures.len() != 1 {
        return Err(RunnerError::Protocol("envelope signatures"));
    }
    let key_id = first
        .get("keyId")
        .and_then(Value::as_str)
        .ok_or(RunnerError::Protocol("signature keyId"))?;
    let algorithm = first
        .get("algorithm")
        .and_then(Value::as_str)
        .ok_or(RunnerError::Protocol("signature algorithm"))?;
    if key_id != expected_key_id || algorithm != "Ed25519" {
        return Err(RunnerError::Protocol("signature key"));
    }
    let signed_at = first
        .get("signedAt")
        .and_then(Value::as_str)
        .ok_or(RunnerError::Protocol("signedAt"))?;
    let cert = first
        .get("signerCertificateObjectDigest")
        .and_then(Value::as_str)
        .ok_or(RunnerError::Protocol("signer cert"))?;
    let signature_b64 = first
        .get("signature")
        .and_then(Value::as_str)
        .ok_or(RunnerError::Protocol("signature"))?;
    let expected_payload = tagged_hash(
        "artifact-payload",
        1,
        &json!({
            "schemaName": schema_name,
            "schemaVersion": schema_version,
            "payload": payload
        }),
    )?;
    let stated = envelope
        .get("payloadDigest")
        .and_then(Value::as_str)
        .ok_or(RunnerError::Protocol("payloadDigest"))?;
    if stated != expected_payload {
        return Err(RunnerError::Protocol("payloadDigest"));
    }
    let input = tagged_hash(
        "artifact-signature-input",
        1,
        &json!({
            "schemaName": schema_name,
            "schemaVersion": schema_version,
            "payloadDigest": expected_payload,
            "keyId": key_id,
            "algorithm": algorithm,
            "signedAt": signed_at,
            "signerCertificateObjectDigest": cert
        }),
    )?;
    let raw = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, signature_b64)
        .map_err(|_| RunnerError::Protocol("signature b64"))?;
    let sig = Signature::from_slice(&raw).map_err(|_| RunnerError::Protocol("signature length"))?;
    verifying_key
        .verify(input.as_bytes(), &sig)
        .map_err(|_| RunnerError::Protocol("signature verify"))?;
    Ok(())
}

pub fn envelope_object_digest(envelope: &Value) -> Result<String, RunnerError> {
    Ok(sha256_digest_tagged(&canonical_json(envelope)?))
}

fn project_payload(domain: &str, payload: &Value) -> Result<Value, RunnerError> {
    let projected = match domain {
        "snapshot-root" => {
            let obj = payload.as_object().ok_or(RunnerError::CanonicalJson)?;
            reject_unknown(obj, SNAPSHOT_ROOT_FIELDS)?;
            let mut out = Map::new();
            for field in SNAPSHOT_ROOT_FIELDS {
                if let Some(value) = obj.get(*field) {
                    if *field == "filesystem" {
                        let fs = value.as_object().ok_or(RunnerError::CanonicalJson)?;
                        reject_unknown(fs, FILESYSTEM_FIELDS)?;
                        out.insert(
                            (*field).to_string(),
                            project_object(value, FILESYSTEM_FIELDS),
                        );
                    } else {
                        out.insert((*field).to_string(), value.clone());
                    }
                }
            }
            Value::Object(sort_snapshot_root(out))
        }
        "git-history-root" => {
            let obj = payload.as_object().ok_or(RunnerError::CanonicalJson)?;
            reject_unknown(obj, GIT_HISTORY_FIELDS)?;
            Ok::<Value, RunnerError>(project_object(payload, GIT_HISTORY_FIELDS))?
        }
        "artifact-payload" => project_object(payload, &["schemaName", "schemaVersion", "payload"]),
        "artifact-signature-input" => project_object(
            payload,
            &[
                "schemaName",
                "schemaVersion",
                "payloadDigest",
                "keyId",
                "algorithm",
                "signedAt",
                "signerCertificateObjectDigest",
            ],
        ),
        "candidate-tree" => {
            let obj = payload.as_object().ok_or(RunnerError::CanonicalJson)?;
            reject_unknown(obj, &["entries"])?;
            Value::Object(sort_entries_field(project_object(payload, &["entries"])))
        }
        "directory-tree" => {
            let obj = payload.as_object().ok_or(RunnerError::CanonicalJson)?;
            reject_unknown(obj, &["path", "entries"])?;
            Value::Object(sort_entries_field(project_object(
                payload,
                &["path", "entries"],
            )))
        }
        _ => return Err(RunnerError::Protocol("unknown digest domain")),
    };
    Ok(projected)
}

fn reject_unknown(obj: &Map<String, Value>, allowed: &[&str]) -> Result<(), RunnerError> {
    for key in obj.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(RunnerError::CanonicalJson);
        }
    }
    Ok(())
}

fn project_object(value: &Value, fields: &[&str]) -> Value {
    let Some(obj) = value.as_object() else {
        return value.clone();
    };
    let mut out = Map::new();
    for field in fields {
        if let Some(v) = obj.get(*field) {
            out.insert((*field).to_string(), v.clone());
        }
    }
    Value::Object(out)
}

fn sort_entries_field(value: Value) -> Map<String, Value> {
    let mut map = match value {
        Value::Object(obj) => obj,
        _ => Map::new(),
    };
    if let Some(Value::Array(entries)) = map.get("entries").cloned() {
        let mut sorted = entries;
        sorted.sort_by(|a, b| {
            let left = a.get("path").and_then(Value::as_str).unwrap_or("");
            let right = b.get("path").and_then(Value::as_str).unwrap_or("");
            left.cmp(right)
        });
        map.insert("entries".into(), Value::Array(sorted));
    }
    map
}

fn sort_snapshot_root(mut obj: Map<String, Value>) -> Map<String, Value> {
    if let Some(Value::Array(entries)) = obj.get("entries").cloned() {
        let mut sorted = entries;
        sorted.sort_by(|a, b| {
            let left = a.get("path").and_then(Value::as_str).unwrap_or("");
            let right = b.get("path").and_then(Value::as_str).unwrap_or("");
            left.cmp(right)
        });
        obj.insert("entries".into(), Value::Array(sorted));
    }
    if let Some(Value::Array(ignored)) = obj.get("ignoredPathDigests").cloned() {
        let mut sorted: Vec<String> = ignored
            .iter()
            .map(|v| v.as_str().unwrap_or("").to_string())
            .collect();
        sorted.sort();
        obj.insert(
            "ignoredPathDigests".into(),
            Value::Array(sorted.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(Value::Array(excluded)) = obj.get("excludedPaths").cloned() {
        let mut sorted = excluded;
        sorted.sort_by(|a, b| {
            let left = a
                .get("path")
                .and_then(Value::as_object)
                .and_then(|o| o.get("value"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let right = b
                .get("path")
                .and_then(Value::as_object)
                .and_then(|o| o.get("value"))
                .and_then(Value::as_str)
                .unwrap_or("");
            left.cmp(right)
        });
        obj.insert("excludedPaths".into(), Value::Array(sorted));
    }
    obj
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let hashed = Sha256::digest(key);
        k[..hashed.len()].copy_from_slice(&hashed);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = k;
    let mut opad = k;
    for b in &mut ipad {
        *b ^= 0x36;
    }
    for b in &mut opad {
        *b ^= 0x5c;
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    let out = outer.finalize();
    let mut mac = [0u8; 32];
    mac.copy_from_slice(&out);
    mac
}

fn hex_of(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push(HEX[(byte >> 4) as usize] as char);
        hex.push(HEX[(byte & 0x0f) as usize] as char);
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::{hmac_ignored_path, snapshot_root_digest};
    use serde_json::json;
    use std::fs;

    #[test]
    fn hmac_is_keyed_not_bare_path_hash() {
        let key = [9u8; 32];
        let hmac = hmac_ignored_path(&key, ".env");
        let unsalted = crate::config::sha256_digest_tagged(b".env");
        assert_ne!(hmac, unsalted);
        assert!(hmac.starts_with("sha256:"));
        assert_ne!(hmac_ignored_path(&[8u8; 32], ".env"), hmac);
    }

    #[test]
    fn snapshot_root_golden_empty_tree() {
        let golden_text = fs::read_to_string(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/contracts/test/fixtures/golden/snapshot-root-vectors.json"),
        )
        .expect("golden");
        let golden: serde_json::Value = serde_json::from_str(&golden_text).expect("parse");
        for case in golden["cases"].as_array().expect("cases") {
            let digest = snapshot_root_digest(&case["payload"]).expect("hash");
            assert_eq!(
                digest,
                case["digest"].as_str().expect("digest"),
                "{}",
                case["name"]
            );
        }
        let extra = json!({ "extra": true });
        assert!(snapshot_root_digest(&extra).is_err());
    }
}
