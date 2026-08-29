use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let contracts_generated = manifest_dir
        .join("..")
        .join("..")
        .join("packages")
        .join("contracts")
        .join("src")
        .join("generated");
    let run_states_path = contracts_generated.join("run-states.ts");
    let digest_path = contracts_generated.join("digest-projections.ts");
    println!("cargo:rerun-if-changed={}", run_states_path.display());
    println!("cargo:rerun-if-changed={}", digest_path.display());

    let run_states_source = fs::read_to_string(&run_states_path).expect("read run-states.ts");
    let digest_source = fs::read_to_string(&digest_path).expect("read digest-projections.ts");
    let run_states = extract_string_literals_between(
        &run_states_source,
        "export const RUN_STATES = [",
        "] as const",
    );
    let digest_domains = extract_field_strings(&digest_source, "domain: \"");
    assert!(
        !run_states.is_empty(),
        "run states registry must not be empty"
    );
    assert_eq!(
        digest_domains.len(),
        26,
        "digest projection registry must have 26 domains"
    );

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::create_dir_all(out_dir.join("generated")).expect("create generated dir");
    fs::write(
        out_dir.join("generated").join("run_states.rs"),
        render_string_enum("RunState", &run_states),
    )
    .expect("write run_states.rs");
    fs::write(
        out_dir.join("generated").join("digest_domains.rs"),
        render_string_enum("DigestDomain", &digest_domains),
    )
    .expect("write digest_domains.rs");
    fs::write(
        out_dir.join("generated").join("envelope_digests.rs"),
        r#"#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct PayloadDigest(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct ObjectDigest(pub String);
"#,
    )
    .expect("write envelope_digests.rs");
}

fn extract_string_literals_between(source: &str, start: &str, end: &str) -> Vec<String> {
    let start_idx = source
        .find(start)
        .unwrap_or_else(|| panic!("missing marker {start}"));
    let rest = &source[start_idx + start.len()..];
    let end_idx = rest
        .find(end)
        .unwrap_or_else(|| panic!("missing terminator {end}"));
    extract_quoted(&rest[..end_idx])
}

fn extract_field_strings(source: &str, marker: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = source;
    while let Some(index) = rest.find(marker) {
        rest = &rest[index + marker.len()..];
        let Some(end) = rest.find('"') else {
            break;
        };
        out.push(rest[..end].to_string());
        rest = &rest[end + 1..];
    }
    out
}

fn extract_quoted(block: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = block;
    while let Some(index) = rest.find('"') {
        rest = &rest[index + 1..];
        let Some(end) = rest.find('"') else {
            break;
        };
        out.push(rest[..end].to_string());
        rest = &rest[end + 1..];
    }
    out
}

fn rust_ident(value: &str) -> String {
    let mut ident = String::new();
    let mut upper = true;
    for ch in value.chars() {
        if ch == '-' || ch == '_' {
            upper = true;
            continue;
        }
        if upper {
            ident.push(ch.to_ascii_uppercase());
            upper = false;
        } else {
            ident.push(ch.to_ascii_lowercase());
        }
    }
    ident
}

fn render_string_enum(name: &str, values: &[String]) -> String {
    let mut out = String::new();
    out.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]\n");
    out.push_str("pub enum ");
    out.push_str(name);
    out.push_str(" {\n");
    for value in values {
        out.push_str("    #[serde(rename = \"");
        out.push_str(value);
        out.push_str("\")]\n");
        out.push_str("    ");
        out.push_str(&rust_ident(value));
        out.push_str(",\n");
    }
    out.push_str("}\n");
    out
}
