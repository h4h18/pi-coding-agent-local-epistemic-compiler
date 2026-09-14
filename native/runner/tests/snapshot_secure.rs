#![cfg(windows)]

use ed25519_dalek::SigningKey;
use pi_hec_runner::snapshot::{
    CHUNK_BYTES, SnapshotError, SnapshotRequest, capture_workspace, lfs_pointer_identity,
    snapshot_commit_request,
};
use pi_hec_runner::windows::paths::{
    PathReject, classify_snapshot_root, long_path_for, reject_reserved_and_trailing,
    reject_unc_device_drive_relative, short_path_for,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pi-hec-snap-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp root");
    long_path_for(&dir).unwrap_or(dir)
}

fn key() -> [u8; 32] {
    [3u8; 32]
}

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

const SIGN_KEY_ID: &str = "runner-sign-1";
const CERT_DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn capture(root: &Path) -> Result<pi_hec_runner::snapshot::SnapshotCapture, SnapshotError> {
    let signing = signing_key();
    capture_workspace(&SnapshotRequest {
        repository_id: "repo1",
        workspace_id: "ws1",
        runner_id: "runner-1",
        root,
        project_metadata_key: &key(),
        signing_key: &signing,
        signature_key_id: SIGN_KEY_ID,
        signer_certificate_object_digest: CERT_DIGEST,
        force_no_vss: true,
        mutate_between_scans: None,
    })
}

fn write_index_entry(root: &Path, rel: &str, content: &[u8]) {
    let repo = gix::init(root).unwrap_or_else(|_| {
        gix::open_opts(root, gix::open::Options::isolated()).expect("open after init")
    });
    let blob = repo.write_blob(content).expect("write blob");
    let oid = blob.detach();
    let mut state = gix::index::State::new(gix::hash::Kind::Sha1);
    let flags = gix::index::entry::Flags::from_bits_truncate(rel.len() as u32);
    state.dangerously_push_entry(
        gix::index::entry::Stat::default(),
        oid,
        flags,
        gix::index::entry::Mode::FILE,
        rel.as_bytes().into(),
    );
    state.sort_entries();
    let mut index = gix::index::File::from_state(state, repo.git_dir().join("index"));
    index
        .write(gix::index::write::Options::default())
        .expect("write index");
}

#[test]
fn escape_unc_device_and_drive_relative_rejected() {
    assert_eq!(
        reject_unc_device_drive_relative(r"\\server\share\repo").unwrap_err(),
        PathReject::Unc
    );
    assert_eq!(
        reject_unc_device_drive_relative(r"\\.\C:\Windows").unwrap_err(),
        PathReject::DeviceNamespace
    );
    assert_eq!(
        reject_unc_device_drive_relative(r"C:foo").unwrap_err(),
        PathReject::DriveRelative
    );
    let err = capture(Path::new(r"\\localhost\c$\Windows")).unwrap_err();
    assert!(err.to_string().contains("SNAPSHOT_ESCAPE"), "{err}");
}

#[test]
fn junction_escape_is_rejected() {
    let root = temp_root("junction");
    let outside = temp_root("junction-outside");
    fs::write(outside.join("secret.txt"), b"secret").unwrap();
    let junction = root.join("escape");
    let status = Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &junction.to_string_lossy(),
            &outside.to_string_lossy(),
        ])
        .status()
        .expect("mklink");
    if !status.success() {
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
        panic!("junction fixture requires mklink /J");
    }
    let err = capture(&root).unwrap_err();
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside);
    assert!(
        err.to_string().contains("SNAPSHOT_ESCAPE"),
        "junction must be rejected, got {err}"
    );
}

#[test]
fn ads_is_captured_not_used_as_escape() {
    let root = temp_root("ads");
    let file = root.join("notes.txt");
    fs::write(&file, b"visible").unwrap();
    let stream_path = format!("{}:secret", file.display());
    fs::write(&stream_path, b"hidden-ads").expect("write ADS");
    let snap = capture(&root).expect("snapshot with ADS");
    let entries = snap.manifest["entries"].as_array().expect("entries");
    let notes = entries
        .iter()
        .find(|e| e["path"] == "notes.txt")
        .expect("notes.txt");
    let streams = notes["platformMetadata"]["alternateStreams"]
        .as_array()
        .expect("streams");
    assert!(
        streams.iter().any(|s| s["name"] == "secret"),
        "ADS secret stream must be enumerated: {streams:?}"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn hardlink_outside_tree_is_rejected() {
    let root = temp_root("hardlink");
    let outside = temp_root("hardlink-out");
    let target = outside.join("payload.bin");
    fs::write(&target, b"shared").unwrap();
    let inside = root.join("inside.bin");
    fs::hard_link(&target, &inside).expect("hardlink");
    let err = capture(&root).unwrap_err();
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside);
    assert!(
        err.to_string().contains("HARDLINK") || err.to_string().contains("SNAPSHOT_ESCAPE"),
        "external hardlink must be rejected, got {err}"
    );
}

#[test]
fn dirty_untracked_and_deleted_state_is_reproducible() {
    let root = temp_root("dirty");
    fs::write(root.join("tracked.txt"), b"keep").unwrap();
    fs::write(root.join("untracked.txt"), b"new").unwrap();
    fs::write(root.join(".gitignore"), b"ignored.env\n").unwrap();
    fs::write(root.join("ignored.env"), b"SECRET=1").unwrap();
    let first = capture(&root).expect("first dirty snapshot");
    let second = capture(&root).expect("second dirty snapshot");
    assert_eq!(first.manifest["dirty"], true);
    assert_eq!(first.manifest["rootDigest"], second.manifest["rootDigest"]);
    let paths: Vec<&str> = first.manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["path"].as_str())
        .collect();
    assert!(paths.contains(&"tracked.txt"));
    assert!(paths.contains(&"untracked.txt"));
    assert!(!paths.contains(&"ignored.env"));
    assert!(
        !first.manifest["ignoredPathDigests"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn deleted_tracked_file_is_dirty_index_digest_reproducible() {
    let root = temp_root("deleted");
    write_index_entry(&root, "tracked.txt", b"keep");
    fs::write(root.join("tracked.txt"), b"keep").unwrap();
    fs::remove_file(root.join("tracked.txt")).unwrap();
    let first = capture(&root).expect("deleted tracked capture");
    let second = capture(&root).expect("second deleted capture");
    assert_eq!(first.manifest["dirty"], true);
    assert!(
        first
            .manifest
            .get("gitIndexDigest")
            .and_then(|v| v.as_str())
            .is_some()
    );
    let paths: Vec<&str> = first.manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["path"].as_str())
        .collect();
    assert!(!paths.contains(&"tracked.txt"));
    assert_eq!(first.manifest["rootDigest"], second.manifest["rootDigest"]);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn unstable_tree_without_vss_returns_snapshot_unstable() {
    let root = temp_root("unstable");
    fs::write(root.join("a.txt"), b"one").unwrap();
    let signing = signing_key();
    let err = capture_workspace(&SnapshotRequest {
        repository_id: "repo1",
        workspace_id: "ws1",
        runner_id: "runner-1",
        root: &root,
        project_metadata_key: &key(),
        signing_key: &signing,
        signature_key_id: SIGN_KEY_ID,
        signer_certificate_object_digest: CERT_DIGEST,
        force_no_vss: true,
        mutate_between_scans: Some(&|p| {
            fs::write(p.join("a.txt"), b"two").unwrap();
        }),
    })
    .unwrap_err();
    let _ = fs::remove_dir_all(&root);
    assert!(
        matches!(err, SnapshotError::Unstable),
        "expected SNAPSHOT_UNSTABLE, got {err}"
    );
}

#[test]
fn huge_file_is_chunked_at_4mib() {
    let root = temp_root("huge");
    let size = CHUNK_BYTES as usize + 32;
    fs::write(root.join("big.bin"), vec![9u8; size]).unwrap();
    let snap = capture(&root).expect("huge file snapshot");
    let entry = snap.manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["path"] == "big.bin")
        .expect("big.bin");
    assert_eq!(entry["storage"]["kind"], "chunks");
    let chunks = entry["storage"]["chunks"].as_array().unwrap();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0]["offset"], 0);
    assert_eq!(chunks[0]["length"], CHUNK_BYTES);
    assert_eq!(chunks[1]["offset"], CHUNK_BYTES);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn git_history_does_not_run_hooks() {
    let root = temp_root("githooks");
    fs::create_dir_all(root.join(".git").join("hooks")).unwrap();
    fs::create_dir_all(root.join(".git").join("objects")).unwrap();
    fs::create_dir_all(root.join(".git").join("refs").join("heads")).unwrap();
    fs::write(root.join(".git").join("HEAD"), b"ref: refs/heads/main\n").unwrap();
    fs::write(
        root.join(".git").join("config"),
        b"[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n",
    )
    .unwrap();
    let marker = root.join("HOOK_RAN");
    let hook = root.join(".git").join("hooks").join("pre-commit.bat");
    fs::write(&hook, format!("echo ran > \"{}\"\r\n", marker.display())).unwrap();
    fs::write(root.join("file.txt"), b"hello").unwrap();
    let snap = capture(&root);
    assert!(!marker.exists(), "git hook must not execute");
    let capture = snap.expect("snapshot of git-ish tree");
    assert!(
        capture.manifest.get("gitHistoryRootDigest").is_some()
            == capture
                .manifest
                .get("gitHistoryManifestObjectDigest")
                .is_some()
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn eight_dot_three_alias_root_is_rejected() {
    assert_eq!(
        reject_reserved_and_trailing(r"C:\PROGRA~1\repo").unwrap_err(),
        PathReject::EightDotThreeAlias
    );
    assert_eq!(
        classify_snapshot_root(r"C:\PROGRA~1\repo").unwrap_err(),
        PathReject::EightDotThreeAlias
    );
}

#[test]
fn unicode_nfc_collision_is_rejected() {
    let root = temp_root("unicode");
    fs::write(root.join("cafe.txt"), b"ascii").unwrap();
    let nfd = "cafe\u{0301}.txt";
    let nfd_path = root.join(nfd);
    let _ = fs::write(&nfd_path, b"nfd");
    let names: Vec<String> = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let result = capture(&root);
    let _ = fs::remove_dir_all(&root);
    let distinct = names.len() >= 2;
    if distinct {
        let err = result.expect_err("NFC/NFD siblings must be rejected");
        assert!(
            err.to_string().contains("SNAPSHOT_ESCAPE") || err.to_string().contains("COLLISION"),
            "{err}"
        );
    } else {
        result.expect("single-name unicode tree must snapshot");
    }
}

#[test]
fn lfs_pointer_is_stored_not_smudged() {
    let root = temp_root("lfs");
    let pointer = concat!(
        "version https://git-lfs.github.com/spec/v1\n",
        "oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n",
        "size 12345\n"
    );
    assert!(lfs_pointer_identity(pointer.as_bytes()));
    write_index_entry(&root, "big.bin", pointer.as_bytes());
    fs::write(root.join("big.bin"), pointer.as_bytes()).unwrap();
    let snap = capture(&root).expect("lfs pointer snapshot");
    let entry = snap.manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["path"] == "big.bin")
        .expect("big.bin");
    assert_eq!(entry["storage"]["kind"], "blob");
    let digest = entry["storage"]["objectDigest"].as_str().expect("digest");
    let blob = snap
        .blobs
        .iter()
        .find(|(d, _)| d == digest)
        .expect("pointer blob");
    assert_eq!(blob.1, pointer.as_bytes());
    assert_ne!(blob.1, b"this is not the payload");
    assert!(entry.get("gitObjectId").and_then(|v| v.as_str()).is_some());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn nested_git_dir_is_excluded() {
    let root = temp_root("nested-git");
    fs::write(root.join("keep.txt"), b"ok").unwrap();
    fs::create_dir_all(root.join("vendor").join("lib").join(".git").join("objects")).unwrap();
    fs::write(
        root.join("vendor")
            .join("lib")
            .join(".git")
            .join("objects")
            .join("pack"),
        b"secret-objects",
    )
    .unwrap();
    let snap = capture(&root).expect("nested git snapshot");
    let paths: Vec<&str> = snap.manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["path"].as_str())
        .collect();
    assert!(paths.contains(&"keep.txt"));
    assert!(!paths.iter().any(|p| p.contains(".git")));
    let excluded = snap.manifest["excludedPaths"].as_array().unwrap();
    assert!(excluded.iter().any(|e| {
        e["path"]["value"] == "vendor/lib/.git" && e["correctnessImpact"] == "possible"
    }));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn nested_dependency_dir_is_excluded() {
    let root = temp_root("nested-nm");
    fs::create_dir_all(
        root.join("packages")
            .join("foo")
            .join("node_modules")
            .join("x"),
    )
    .unwrap();
    fs::write(
        root.join("packages")
            .join("foo")
            .join("node_modules")
            .join("x")
            .join("index.js"),
        b"dep",
    )
    .unwrap();
    fs::write(root.join("packages").join("foo").join("app.ts"), b"ok").unwrap();
    let snap = capture(&root).expect("nested node_modules");
    let paths: Vec<&str> = snap.manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["path"].as_str())
        .collect();
    assert!(
        paths
            .iter()
            .any(|p| *p == "packages/foo/app.ts" || *p == "packages/foo")
    );
    assert!(!paths.iter().any(|p| p.contains("node_modules")));
    let excluded = snap.manifest["excludedPaths"].as_array().unwrap();
    assert!(
        excluded
            .iter()
            .any(|e| e["path"]["value"] == "packages/foo/node_modules")
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn gitignore_pem_hmac_and_junction_not_followed() {
    let root = temp_root("ignore-junc");
    let outside = temp_root("ignore-junc-out");
    fs::write(outside.join("secret.txt"), b"outside").unwrap();
    fs::write(root.join(".gitignore"), b"*.pem\n").unwrap();
    fs::write(root.join("secrets.pem"), b"-----BEGIN PRIVATE KEY-----\n").unwrap();
    let hmac_only = capture(&root).expect("pem ignored");
    assert!(
        !hmac_only.manifest["ignoredPathDigests"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let paths: Vec<&str> = hmac_only.manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["path"].as_str())
        .collect();
    assert!(!paths.contains(&"secrets.pem"));
    let junction = root.join("escape");
    let status = Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &junction.to_string_lossy(),
            &outside.to_string_lossy(),
        ])
        .status()
        .expect("mklink");
    if !status.success() {
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
        panic!("junction fixture requires mklink /J");
    }
    let err = capture(&root).unwrap_err();
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside);
    assert!(
        err.to_string().contains("SNAPSHOT_ESCAPE"),
        "junction must be rejected even with gitignore, got {err}"
    );
}

#[test]
fn snapshot_commit_request_is_signed_envelope() {
    let root = temp_root("sign");
    fs::write(root.join("a.txt"), b"x").unwrap();
    let snap = capture(&root).expect("signed capture");
    assert_eq!(snap.envelope["schemaName"], "SnapshotManifest");
    assert_eq!(snap.envelope["signatures"][0]["algorithm"], "Ed25519");
    let signing = signing_key();
    let body = snapshot_commit_request(
        &snap.manifest,
        &signing,
        SIGN_KEY_ID,
        CERT_DIGEST,
        "2026-08-28T00:00:00.000Z",
    )
    .expect("commit body");
    assert_eq!(body["schemaVersion"], 1);
    assert_eq!(body["manifest"]["schemaName"], "SnapshotManifest");
    assert!(
        body["manifestObjectDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    if let Some(history) = &snap.git_history {
        assert_eq!(history["replaceRefsIgnored"], true);
        assert!(history["commits"].is_array());
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn dirent_short_name_open_is_rejected_when_available() {
    let root = temp_root("eight-child");
    let long_dir = root.join("VeryLongDirectoryNameForEightThree");
    fs::create_dir(&long_dir).unwrap();
    fs::write(long_dir.join("f.txt"), b"x").unwrap();
    let short = short_path_for(&long_dir).unwrap_or(long_dir.clone());
    if short != long_dir {
        let err = capture(&short).unwrap_err();
        assert!(
            err.to_string().contains("EIGHT_DOT_THREE")
                || err.to_string().contains("SNAPSHOT_ESCAPE"),
            "{err}"
        );
    }
    let _ = fs::remove_dir_all(&root);
}
