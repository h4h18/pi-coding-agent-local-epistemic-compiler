#[cfg(test)]
fn crate_name() -> &'static str {
    env!("CARGO_PKG_NAME")
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), pi_hec_runner::config::RunnerError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(pi_hec_runner::operations::run_broker())
}

pub mod generated {
    include!(concat!(env!("OUT_DIR"), "/generated/run_states.rs"));
    include!(concat!(env!("OUT_DIR"), "/generated/digest_domains.rs"));
    include!(concat!(env!("OUT_DIR"), "/generated/envelope_digests.rs"));
}

#[cfg(test)]
mod tests {
    use super::crate_name;

    #[test]
    fn package_name_is_pi_hec_runner() {
        assert_eq!(crate_name(), "pi-hec-runner");
    }
}

#[cfg(test)]
mod contracts {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;
    use std::fs;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("packages")
            .join("contracts")
            .join("test")
            .join("fixtures")
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let digest = Sha256::digest(bytes);
        let mut hex = String::with_capacity(64);
        for byte in digest {
            write!(&mut hex, "{byte:02x}").expect("write hex");
        }
        format!("sha256:{hex}")
    }

    #[test]
    fn rfc8785_official_vectors_match() {
        for name in [
            "arrays",
            "french",
            "structures",
            "unicode",
            "values",
            "weird",
        ] {
            let input = fs::read_to_string(
                fixtures_dir()
                    .join("rfc8785")
                    .join(format!("{name}.input.json")),
            )
            .unwrap_or_else(|_| panic!("read {name} input"));
            let expected = fs::read_to_string(
                fixtures_dir()
                    .join("rfc8785")
                    .join(format!("{name}.output.json")),
            )
            .unwrap_or_else(|_| panic!("read {name} output"));
            let value: serde_json::Value =
                serde_json::from_str(input.trim_start_matches('\u{feff}'))
                    .unwrap_or_else(|_| panic!("parse {name} input"));
            let canonical = serde_json_canonicalizer::to_string(&value).expect("canonicalize");
            assert_eq!(
                canonical,
                expected.trim_start_matches('\u{feff}').trim_end(),
                "{name}"
            );
        }
    }

    #[test]
    fn payload_digest_golden_matches_typescript() {
        let golden_text =
            fs::read_to_string(fixtures_dir().join("golden").join("payload-digest.json"))
                .expect("read golden");
        let golden: serde_json::Value = serde_json::from_str(&golden_text).expect("parse golden");
        let tagged = serde_json::json!({
            "domain": "artifact-payload",
            "version": 1,
            "payload": {
                "schemaName": golden["schemaName"],
                "schemaVersion": golden["schemaVersion"],
                "payload": golden["payload"]
            }
        });
        let canonical = serde_json_canonicalizer::to_vec(&tagged).expect("canonicalize tagged");
        let digest = sha256_hex(&canonical);
        assert_eq!(digest, golden["digest"].as_str().expect("digest field"));
        let reparsed: serde_json::Value =
            serde_json::from_slice(&canonical).expect("parse canonical");
        let recanonical = serde_json_canonicalizer::to_vec(&reparsed).expect("re-canonicalize");
        assert_eq!(sha256_hex(&recanonical), digest);
    }

    #[test]
    fn envelope_object_digest_golden_matches_typescript() {
        let golden_text = fs::read_to_string(
            fixtures_dir()
                .join("golden")
                .join("envelope-object-digest.json"),
        )
        .expect("read golden");
        let golden: serde_json::Value = serde_json::from_str(&golden_text).expect("parse golden");
        let envelope = golden["envelope"].clone();
        let canonical = serde_json_canonicalizer::to_vec(&envelope).expect("canonicalize envelope");
        let digest = sha256_hex(&canonical);
        assert_eq!(digest, golden["digest"].as_str().expect("digest field"));
    }

    #[test]
    fn generated_run_state_round_trips() {
        let state = crate::generated::RunState::CloudPrepared;
        let encoded = serde_json::to_string(&state).expect("encode");
        assert_eq!(encoded, "\"CLOUD_PREPARED\"");
        let decoded: crate::generated::RunState = serde_json::from_str(&encoded).expect("decode");
        assert_eq!(decoded, state);
    }

    #[test]
    fn generated_digest_domain_quote_round_trips() {
        let domain = crate::generated::DigestDomain::Quote;
        let encoded = serde_json::to_string(&domain).expect("encode");
        assert_eq!(encoded, "\"quote\"");
        let decoded: crate::generated::DigestDomain =
            serde_json::from_str(&encoded).expect("decode");
        assert_eq!(decoded, domain);
        let payload = crate::generated::PayloadDigest("sha256:00".to_string());
        let encoded_payload = serde_json::to_string(&payload).expect("encode payload digest");
        assert_eq!(encoded_payload, "\"sha256:00\"");
    }

    #[test]
    fn snapshot_root_golden_vectors_match_typescript() {
        let golden_text = fs::read_to_string(
            fixtures_dir()
                .join("golden")
                .join("snapshot-root-vectors.json"),
        )
        .expect("read snapshot-root golden");
        let golden: serde_json::Value = serde_json::from_str(&golden_text).expect("parse golden");
        for case in golden["cases"].as_array().expect("cases") {
            let tagged = serde_json::json!({
                "domain": "snapshot-root",
                "version": 1,
                "payload": case["payload"]
            });
            let canonical = serde_json_canonicalizer::to_vec(&tagged).expect("canonicalize");
            let digest = sha256_hex(&canonical);
            assert_eq!(
                digest,
                case["digest"].as_str().expect("digest"),
                "{}",
                case["name"].as_str().unwrap_or("unnamed")
            );
        }
    }
}
