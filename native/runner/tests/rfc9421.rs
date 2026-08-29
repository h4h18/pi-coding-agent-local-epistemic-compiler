use pi_hec_runner::api_client::{content_digest_sha256, signature_params_inner};
use pi_hec_runner::config::{MUTATION_PROFILE_TAG, MUTATION_SIGNATURE_COMPONENTS};
use sha2::Digest;

#[test]
fn rfc9530_content_digest_matches_sha256_base64() {
    let body = b"{\"schemaVersion\":1}";
    let digest = sha2::Sha256::digest(body);
    let expected = format!(
        "sha-256=:{}:",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, digest)
    );
    assert_eq!(content_digest_sha256(body), expected);
}

#[test]
fn mutation_params_cover_profile_and_ed25519() {
    let params = signature_params_inner(
        &MUTATION_SIGNATURE_COMPONENTS,
        1_700_000_000,
        1_700_000_060,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "key-1",
    );
    assert!(params.contains(MUTATION_PROFILE_TAG));
    assert!(params.contains("alg=\"ed25519\""));
    assert!(params.starts_with("(\"@method\""));
}
