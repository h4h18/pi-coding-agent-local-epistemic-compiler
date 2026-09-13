#![cfg(windows)]

use ed25519_dalek::SigningKey;
use pi_hec_runner::config::{sha256_digest_tagged, RunnerConfig};
use pi_hec_runner::local_store::LocalStore;
use pi_hec_runner::promotion::journal::{consume_grant, workspace_recovery};
use pi_hec_runner::promotion::{
    apply_promotion, candidate_tree_digest, read_workspace_files, reconcile_all, security_digest_of, streams_of,
    workspace_snapshot_root, ApplyRequest, Checkpoint, EntryKind, PromotionEntry, PromotionError,
};
use pi_hec_runner::snapshot::manifest::{envelope_object_digest, sign_envelope};
use pi_hec_runner::windows::current_user_sid_string;
use pi_hec_runner::windows::paths::long_path_for;
use pi_hec_runner::windows::presence::{request_platform_assertion_timed, PresenceError};
use pi_hec_runner::windows::replace::{
    apply_captured_metadata, atomic_replace, capture_existing, in_parent_create_temp, staging_dir, write_staging_file,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{ERROR_SUCCESS, HLOCAL, LocalFree};
use windows::Win32::Security::{GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};

const NOW: &str = "2026-08-29T00:00:00.000Z";
const LATER: &str = "2026-08-29T01:00:00.000Z";
const PAST: &str = "2026-08-28T00:00:00.000Z";
const RUN: &str = "run_01900000-0000-7000-8000-000000000030";
const APPROVAL: &str = "approval_01900000-0000-7000-8000-000000000031";
const CERT: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_ID: &str = "runner-sign-1";

fn temp_config(name: &str) -> (RunnerConfig, PathBuf) {
    let dir = std::env::temp_dir().join(format!("pi-hec-promote-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp");
    let dir = long_path_for(&dir).unwrap_or(dir);
    let workspace = dir.join("ws");
    fs::create_dir_all(&workspace).expect("workspace");
    let config = RunnerConfig {
        data_dir: dir.join("data"),
        control_base_url: "https://control.local".into(),
        runner_id: "runner-test".into(),
        key_id: "key-test".into(),
        pi_executable: PathBuf::from("pi.exe"),
        pi_args: Vec::new(),
        pi_stdio_log: None,
        identity_dir: dir.join("identity"),
        capabilities_path: dir.join("capabilities.json"),
    };
    fs::create_dir_all(&config.data_dir).expect("data");
    (config, workspace)
}

fn signing() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn open_store(config: &RunnerConfig) -> LocalStore {
    let store = LocalStore::open(config).expect("store");
    store.store_ed25519_secret(&[7u8; 32]).expect("ed25519");
    store
}

fn expected_tree(files: &BTreeMap<&str, &[u8]>, root: &Path) -> String {
    for (path, bytes) in files {
        let dest = join(root, path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(&dest, bytes).expect("write expected");
    }
    candidate_tree_digest(root).expect("tree")
}

fn join(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel.split('/') {
        path.push(part);
    }
    path
}

fn presence_ok(_: &str) -> Result<(), PresenceError> {
    Ok(())
}

fn grant_payload(action: &str, expires: &str, challenge: &str, decision_digest: &str, subject_digest: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "approvalId": APPROVAL,
        "projectId": "proj-1",
        "principalId": "user-1",
        "challengeObjectDigest": challenge,
        "approvalDecisionObjectDigest": decision_digest,
        "subjectObjectDigest": subject_digest,
        "policyObjectDigest": CERT,
        "issuedAt": NOW,
        "expiresAt": expires,
        "scope": "run",
        "runId": RUN,
        "action": action
    })
}

fn subject_payload(kind: &str, mode: &str) -> Value {
    if kind == "command" {
        json!({
            "schemaVersion": 1,
            "kind": "command",
            "runId": RUN,
            "phase": "CANDIDATE",
            "resolvedCommandSpecObjectDigest": CERT,
            "environmentSealObjectDigest": CERT,
            "sandboxPolicyObjectDigest": CERT,
            "inputTreeRootDigest": CERT
        })
    } else {
        json!({
            "schemaVersion": 1,
            "kind": "workspace-promotion",
            "runId": RUN,
            "candidateManifestObjectDigest": CERT,
            "verdictReportObjectDigest": CERT,
            "baseSnapshotRootDigest": CERT,
            "currentWorkspaceRootDigest": CERT,
            "runnerId": "runner-1",
            "promotionMode": mode
        })
    }
}

fn decision_payload(nonce: &str, challenge: &str, subject_digest: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "approvalId": APPROVAL,
        "projectId": "proj-1",
        "principalId": "user-1",
        "challengeObjectDigest": challenge,
        "subjectObjectDigest": subject_digest,
        "policyObjectDigest": CERT,
        "displayArtifactObjectDigest": CERT,
        "nonce": nonce,
        "decision": "APPROVE",
        "decidedAt": NOW,
        "expiresAt": LATER
    })
}

fn signed_envelopes(
    action: &str,
    expires: &str,
    nonce: &str,
    subject_kind: &str,
    promotion_mode: &str,
) -> (Value, Value, Value) {
    let key = signing();
    let subject = sign_envelope(
        "ApprovalSubject",
        &subject_payload(subject_kind, promotion_mode),
        &key,
        KEY_ID,
        CERT,
        NOW,
    )
    .expect("sign subject");
    let subject_digest = envelope_object_digest(&subject).expect("subject digest");
    let decision = sign_envelope(
        "ApprovalDecision",
        &decision_payload(nonce, CERT, &subject_digest),
        &key,
        KEY_ID,
        CERT,
        NOW,
    )
    .expect("sign decision");
    let decision_digest = envelope_object_digest(&decision).expect("decision digest");
    let grant = sign_envelope(
        "ApprovalGrant",
        &grant_payload(action, expires, CERT, &decision_digest, &subject_digest),
        &key,
        KEY_ID,
        CERT,
        NOW,
    )
    .expect("sign grant");
    (grant, subject, decision)
}

struct ApplyExtras<'a> {
    workspace_id: &'a str,
    action: &'a str,
    expires: &'a str,
    nonce: &'a str,
    reuse_nonce: bool,
    skip_session: bool,
    subject_kind: &'a str,
    mode: &'a str,
    signed_mode: &'a str,
    envelopes: Option<(Value, Value, Value)>,
    fail_at_entry: Option<u32>,
    mutate_after_prepared: Option<&'a dyn Fn(&Path)>,
    rewrite_after_entry: Option<(u32, &'a [u8])>,
}

fn extras<'a>(id: &'a str, nonce: &'a str) -> ApplyExtras<'a> {
    ApplyExtras {
        workspace_id: id,
        action: "workspace-promotion",
        expires: LATER,
        nonce,
        reuse_nonce: false,
        skip_session: false,
        subject_kind: "workspace-promotion",
        mode: "ENTRY_JOURNALED",
        signed_mode: "ENTRY_JOURNALED",
        envelopes: None,
        fail_at_entry: None,
        mutate_after_prepared: None,
        rewrite_after_entry: None,
    }
}

fn ensure_workspace(store: &LocalStore, workspace_id: &str, workspace: &Path) {
    if store.lookup_workspace(workspace_id).expect("lookup").is_none() {
        store
            .register_workspace(
                workspace_id,
                "proj-1",
                &workspace.to_string_lossy(),
                &format!("vol-{workspace_id}"),
                &format!("root-{workspace_id}"),
            )
            .expect("register workspace");
    }
}

fn predicted_result_root(workspace: &Path, workspace_id: &str, overlay: &[(&str, Option<&[u8]>)]) -> String {
    let stage = staging_dir(workspace, workspace_id);
    fs::create_dir_all(&stage).expect("stage");
    struct Slot {
        dest: PathBuf,
        bak: PathBuf,
        staged: PathBuf,
        prev: Option<Vec<u8>>,
        replaced: bool,
    }
    let mut slots = Vec::new();
    for (index, (rel, next)) in overlay.iter().enumerate() {
        let dest = join(workspace, rel);
        match next {
            Some(bytes) if dest.exists() => {
                let meta = capture_existing(&dest).expect("capture");
                let staged = stage.join(format!("{index}.staged"));
                write_staging_file(&staged, bytes).expect("stage write");
                apply_captured_metadata(&staged, &meta).expect("stage meta");
                let bak = stage.join(format!("{index}.bak"));
                fs::rename(&dest, &bak).expect("bak");
                atomic_replace(&staged, &dest).expect("preview replace");
                slots.push(Slot {
                    dest,
                    bak,
                    staged,
                    prev: None,
                    replaced: true,
                });
            }
            Some(bytes) => {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).expect("parent");
                }
                fs::write(&dest, bytes).expect("overlay");
                slots.push(Slot {
                    dest,
                    bak: PathBuf::new(),
                    staged: PathBuf::new(),
                    prev: None,
                    replaced: false,
                });
            }
            None => {
                let prev = Some(fs::read(&dest).expect("backup"));
                let _ = fs::remove_file(&dest);
                slots.push(Slot {
                    dest,
                    bak: PathBuf::new(),
                    staged: PathBuf::new(),
                    prev,
                    replaced: false,
                });
            }
        }
    }
    let snap = workspace_snapshot_root(workspace, workspace_id).expect("predicted snapshot");
    for slot in slots.into_iter().rev() {
        if slot.replaced {
            fs::rename(&slot.dest, &slot.staged).expect("return staged");
            fs::rename(&slot.bak, &slot.dest).expect("restore dest");
        } else {
            match slot.prev {
                Some(bytes) => fs::write(&slot.dest, bytes).expect("restore"),
                None => {
                    let _ = fs::remove_file(&slot.dest);
                }
            }
        }
    }
    snap
}

fn predicted_create_root(workspace: &Path, workspace_id: &str, rel: &str, bytes: &[u8]) -> String {
    let dest = join(workspace, rel);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    let tmp = in_parent_create_temp(&dest);
    fs::write(&tmp, bytes).expect("seed tmp");
    fs::rename(&tmp, &dest).expect("preview rename");
    let snap = workspace_snapshot_root(workspace, workspace_id).expect("create snapshot");
    fs::rename(&dest, &tmp).expect("restore tmp");
    snap
}

fn apply(
    store: &LocalStore,
    workspace: &Path,
    expected: &str,
    entries: Vec<PromotionEntry>,
    crash_after: Option<Checkpoint>,
    extra: ApplyExtras<'_>,
) -> Result<pi_hec_runner::promotion::ApplyOutcome, PromotionError> {
    ensure_workspace(store, extra.workspace_id, workspace);
    let session_nonce = if extra.skip_session {
        if extra.nonce.is_empty() {
            "missing-session-nonce-aaaaaaaaaaaaaaaaaaaa".to_string()
        } else {
            extra.nonce.to_string()
        }
    } else if extra.reuse_nonce {
        extra.nonce.to_string()
    } else {
        store
            .open_trusted_session(CERT, CERT, LATER)
            .expect("session")
            .1
    };
    let (grant_envelope, subject_envelope, decision_envelope) = extra.envelopes.clone().unwrap_or_else(|| {
        signed_envelopes(
            extra.action,
            extra.expires,
            &session_nonce,
            extra.subject_kind,
            extra.signed_mode,
        )
    });
    let signing_key = signing();
    let verifying = signing_key.verifying_key();
    apply_promotion(&ApplyRequest {
        store,
        workspace_id: extra.workspace_id,
        project_id: "proj-1",
        workspace_root: workspace,
        run_id: RUN,
        approval_id: APPROVAL,
        grant_envelope,
        subject_envelope,
        decision_envelope,
        grant_verifying_key: &verifying,
        promotion_mode: extra.mode,
        user_presence: Some(presence_ok),
        candidate_manifest_object_digest: CERT,
        change_set_object_digest: CERT,
        base_snapshot_root_digest: CERT,
        expected_result_root_digest: expected,
        entries,
        signing_key: &signing_key,
        signature_key_id: KEY_ID,
        signer_certificate_object_digest: CERT,
        now: NOW,
        crash_after,
        fail_at_entry: extra.fail_at_entry,
        mutate_after_prepared: extra.mutate_after_prepared,
        rewrite_after_entry: extra.rewrite_after_entry,
    })
}

fn set_named_dacl(path: &Path, sddl: &str) {
    let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .expect("sddl");
        let mut present = BOOL(0);
        let mut defaulted = BOOL(0);
        let mut dacl: *mut ACL = std::ptr::null_mut();
        GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted).expect("dacl");
        assert!(present.as_bool() && !dacl.is_null());
        let status = SetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(dacl as *const ACL),
            None,
        );
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        assert_eq!(status, ERROR_SUCCESS);
    }
}

fn write_base(workspace: &Path, files: &[(&str, &[u8])]) {
    for (path, bytes) in files {
        let dest = join(workspace, path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(dest, bytes).expect("base");
    }
}

#[test]
fn entry_journaled_happy_path_commits_entry_level_and_drops_lease_after_receipt() {
    let (config, workspace) = temp_config("happy");
    write_base(&workspace, &[("a.txt", b"base-a"), ("b.txt", b"base-b")]);
    let expected = predicted_result_root(&workspace, "ws-happy", &[("a.txt", Some(b"next-a".as_slice()))]);
    let store = open_store(&config);
    let outcome = apply(
        &store,
        &workspace,
        &expected,
        vec![PromotionEntry {
            kind: EntryKind::Replace,
            relative_path: "a.txt".into(),
            after_bytes: Some(b"next-a".to_vec()),
        }],
        None,
        extras("ws-happy", "nonce-happy-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    )
    .expect("apply");
    assert_eq!(outcome.receipt["outcome"], "COMMITTED");
    assert_eq!(outcome.receipt["visibilityGuarantee"], "ENTRY_LEVEL");
    assert_ne!(outcome.receipt["visibilityGuarantee"], "ATOMIC_ROOT_SWITCH");
    assert!(!outcome.lease_held);
    let lease = workspace_recovery(&store, "ws-happy").unwrap().unwrap();
    assert_eq!(lease.0, "READY");
    assert!(lease.1.is_none());
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"next-a");
    let snapshot = workspace_snapshot_root(&workspace, "ws-happy").unwrap();
    assert_eq!(outcome.receipt["resultingRootDigest"], snapshot);
    let paths = outcome.receipt["affectedPaths"].as_array().expect("affected");
    assert!(!paths.is_empty());
    assert_eq!(paths[0]["path"], "a.txt");
    assert!(paths[0].get("beforeDigest").is_some());
    assert!(paths[0].get("expectedAfterDigest").is_some());
    assert!(paths[0].get("observedAfterDigest").is_some());
}

#[test]
fn crash_after_every_checkpoint_recovers_to_base_or_candidate() {
    let checkpoints = [
        Checkpoint::Prepared,
        Checkpoint::Committing,
        Checkpoint::AfterFsBeforeSql(0),
        Checkpoint::AfterEntry(0),
        Checkpoint::Verifying,
        Checkpoint::CommittedBeforeReceipt,
        Checkpoint::ReceiptBeforeLeaseDrop,
        Checkpoint::RollingBack,
    ];
    for (i, checkpoint) in checkpoints.iter().enumerate() {
        let (config, workspace) = temp_config(&format!("crash-{i}"));
        write_base(&workspace, &[("a.txt", b"base-a"), ("b.txt", b"base-b")]);
        let base = read_workspace_files(&workspace).unwrap();
        let candidate_dir = temp_config(&format!("crash-cand-{i}")).1;
        let candidate_expected = expected_tree(
            &BTreeMap::from([("a.txt", b"next-a".as_slice()), ("b.txt", b"next-b".as_slice())]),
            &candidate_dir,
        );
        let workspace_id = format!("ws-crash-{i}");
        let nonce = format!("nonce-crash-{i}-aaaaaaaaaaaaaaaaaaaaaa");
        let expected = predicted_result_root(
            &workspace,
            &workspace_id,
            &[
                ("a.txt", Some(b"next-a".as_slice())),
                ("b.txt", Some(b"next-b".as_slice())),
            ],
        );
        {
            let store = open_store(&config);
            let mut extra = extras(&workspace_id, &nonce);
            extra.fail_at_entry = if *checkpoint == Checkpoint::RollingBack {
                Some(1)
            } else {
                None
            };
            let result = apply(
                &store,
                &workspace,
                &expected,
                vec![
                    PromotionEntry {
                        kind: EntryKind::Replace,
                        relative_path: "a.txt".into(),
                        after_bytes: Some(b"next-a".to_vec()),
                    },
                    PromotionEntry {
                        kind: EntryKind::Replace,
                        relative_path: "b.txt".into(),
                        after_bytes: Some(b"next-b".to_vec()),
                    },
                ],
                Some(checkpoint.clone()),
                extra,
            );
            match result {
                Err(PromotionError::InjectedCrash(hit)) => assert_eq!(hit, *checkpoint),
                Ok(outcome) => panic!("expected crash at {checkpoint:?}, got {:?}", outcome.receipt["outcome"]),
                Err(other) => panic!("unexpected error {other}"),
            }
        }
        let store = open_store(&config);
        let after = read_workspace_files(&workspace).unwrap();
        let recovered = candidate_tree_digest(&workspace).unwrap();
        let is_base = after == base;
        let is_candidate = recovered == candidate_expected;
        assert!(
            is_base || is_candidate,
            "checkpoint {checkpoint:?} left mixed tree {after:?}"
        );
        if is_candidate && !is_base {
            assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"next-a");
            assert_eq!(fs::read(workspace.join("b.txt")).unwrap(), b"next-b");
        }
        if is_base {
            assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
            assert_eq!(fs::read(workspace.join("b.txt")).unwrap(), b"base-b");
        }
        let lease = workspace_recovery(&store, &workspace_id).unwrap().unwrap();
        assert_ne!(lease.0, "RECONCILING");
        if lease.0 == "READY" {
            assert!(is_base || is_candidate);
        }
        drop(store);
    }
}

#[test]
fn external_rewrite_during_commit_preserves_foreign_bytes() {
    let (config, workspace) = temp_config("foreign");
    write_base(&workspace, &[("a.txt", b"base-a"), ("b.txt", b"base-b")]);
    let expected = predicted_result_root(
        &workspace,
        "ws-foreign",
        &[
            ("a.txt", Some(b"next-a".as_slice())),
            ("b.txt", Some(b"next-b".as_slice())),
        ],
    );
    let store = open_store(&config);
    let mut extra = extras("ws-foreign", "nonce-foreign-aaaaaaaaaaaaaaaaaaaaaaaaaa");
    extra.rewrite_after_entry = Some((0, b"FOREIGN"));
    let outcome = apply(
        &store,
        &workspace,
        &expected,
        vec![
            PromotionEntry {
                kind: EntryKind::Replace,
                relative_path: "a.txt".into(),
                after_bytes: Some(b"next-a".to_vec()),
            },
            PromotionEntry {
                kind: EntryKind::Replace,
                relative_path: "b.txt".into(),
                after_bytes: Some(b"next-b".to_vec()),
            },
        ],
        None,
        extra,
    )
    .expect("manual");
    assert_eq!(outcome.receipt["outcome"], "MANUAL_RECOVERY_REQUIRED");
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"FOREIGN");
    let lease = workspace_recovery(&store, "ws-foreign").unwrap().unwrap();
    assert_eq!(lease.0, "MANUAL_RECOVERY_REQUIRED");
    let paths = outcome.receipt["affectedPaths"].as_array().expect("affected");
    assert!(paths.iter().any(|p| p["path"] == "a.txt"));
    let evidence = outcome.receipt["recoveryEvidenceObjectDigest"].as_str().expect("evidence");
    assert_ne!(evidence, sha256_digest_tagged(b"manual-recovery"));
}

#[test]
fn drift_before_first_mutation_is_stale_and_does_not_apply_candidate() {
    let (config, workspace) = temp_config("drift");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let expected = predicted_result_root(&workspace, "ws-drift", &[("a.txt", Some(b"next-a".as_slice()))]);
    let store = open_store(&config);
    let mutate = |root: &Path| {
        fs::write(root.join("a.txt"), b"drifted").expect("drift");
    };
    let mut extra = extras("ws-drift", "nonce-drift-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    extra.mutate_after_prepared = Some(&mutate);
    let outcome = apply(
        &store,
        &workspace,
        &expected,
        vec![PromotionEntry {
            kind: EntryKind::Replace,
            relative_path: "a.txt".into(),
            after_bytes: Some(b"next-a".to_vec()),
        }],
        None,
        extra,
    )
    .expect("stale");
    assert_eq!(outcome.receipt["outcome"], "STALE");
    assert_ne!(fs::read(workspace.join("a.txt")).unwrap(), b"next-a");
}

#[test]
fn approval_expiry_replay_deny_and_mismatch_do_not_mutate() {
    let (config, workspace) = temp_config("authz");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let expected = predicted_result_root(&workspace, "ws-authz-ok", &[("a.txt", Some(b"next-a".as_slice()))]);
    let store = open_store(&config);
    let entries = vec![PromotionEntry {
        kind: EntryKind::Replace,
        relative_path: "a.txt".into(),
        after_bytes: Some(b"next-a".to_vec()),
    }];
    let mut expired = extras("ws-authz-exp", "");
    expired.expires = PAST;
    assert!(apply(&store, &workspace, &expected, entries.clone(), None, expired).is_err());
    ensure_workspace(&store, "ws-authz-deny", &workspace);
    let deny_nonce = store.open_trusted_session(CERT, CERT, LATER).expect("deny session").1;
    store
        .consume_trusted_nonce(&deny_nonce, CERT)
        .expect("deny burns nonce");
    let mut deny = extras("ws-authz-deny", &deny_nonce);
    deny.reuse_nonce = true;
    assert!(matches!(
        apply(&store, &workspace, &expected, entries.clone(), None, deny),
        Err(PromotionError::Replay)
    ));
    let mut mismatch = extras("ws-authz-mis", "");
    mismatch.action = "command";
    mismatch.subject_kind = "command";
    assert!(apply(&store, &workspace, &expected, entries.clone(), None, mismatch).is_err());
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
    ensure_workspace(&store, "ws-authz-ok", &workspace);
    let replay_nonce = store.open_trusted_session(CERT, CERT, LATER).expect("replay session").1;
    let mut ok = extras("ws-authz-ok", &replay_nonce);
    ok.reuse_nonce = true;
    apply(&store, &workspace, &expected, entries.clone(), None, ok).expect("first");
    let mut replay = extras("ws-authz-ok2", &replay_nonce);
    replay.reuse_nonce = true;
    assert!(matches!(
        apply(&store, &workspace, &expected, entries.clone(), None, replay),
        Err(PromotionError::Replay)
    ));
}

#[test]
fn grant_is_consumed_once() {
    let (config, workspace) = temp_config("once");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let expected = predicted_result_root(&workspace, "ws-once", &[("a.txt", Some(b"next-a".as_slice()))]);
    let store = open_store(&config);
    ensure_workspace(&store, "ws-once", &workspace);
    let entries = vec![PromotionEntry {
        kind: EntryKind::Replace,
        relative_path: "a.txt".into(),
        after_bytes: Some(b"next-a".to_vec()),
    }];
    let nonce = store.open_trusted_session(CERT, CERT, LATER).expect("session").1;
    let envelopes = signed_envelopes("workspace-promotion", LATER, &nonce, "workspace-promotion", "ENTRY_JOURNALED");
    consume_grant(&store, &envelope_object_digest(&envelopes.0).expect("digest")).expect("consume grant");
    let mut extra = extras("ws-once", &nonce);
    extra.reuse_nonce = true;
    extra.envelopes = Some(envelopes);
    let second = apply(&store, &workspace, &expected, entries, None, extra);
    assert!(matches!(second, Err(PromotionError::GrantConsumed)));
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
}

#[test]
fn root_swap_without_probe_does_not_mutate_or_claim_atomic_switch() {
    let (config, workspace) = temp_config("rootswap");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let expected = predicted_result_root(&workspace, "ws-rootswap", &[("a.txt", Some(b"next-a".as_slice()))]);
    let store = open_store(&config);
    let mut extra = extras("ws-rootswap", "nonce-rootswap-aaaaaaaaaaaaaaaaaaaaaaaaaa");
    extra.mode = "ROOT_SWAP";
    extra.signed_mode = "ROOT_SWAP";
    let result = apply(
        &store,
        &workspace,
        &expected,
        vec![PromotionEntry {
            kind: EntryKind::Replace,
            relative_path: "a.txt".into(),
            after_bytes: Some(b"next-a".to_vec()),
        }],
        None,
        extra,
    );
    assert!(matches!(result, Err(PromotionError::RootSwapUnproven)));
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
}

#[test]
fn existing_replace_preserves_ads_and_security_digest() {
    let (config, workspace) = temp_config("ads");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let ads_path = format!("{}:promo", workspace.join("a.txt").display());
    fs::write(&ads_path, b"ads-bytes").expect("ads");
    let before_sd = security_digest_of(&workspace.join("a.txt")).expect("sd");
    let before_streams = streams_of(&workspace.join("a.txt")).expect("streams");
    assert!(before_streams.iter().any(|(name, bytes)| name == "promo" && bytes == b"ads-bytes"));
    let expected = predicted_result_root(&workspace, "ws-ads", &[("a.txt", Some(b"next-a".as_slice()))]);
    let store = open_store(&config);
    apply(
        &store,
        &workspace,
        &expected,
        vec![PromotionEntry {
            kind: EntryKind::Replace,
            relative_path: "a.txt".into(),
            after_bytes: Some(b"next-a".to_vec()),
        }],
        None,
        extras("ws-ads", "nonce-ads-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    )
    .expect("apply");
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"next-a");
    let after_streams = streams_of(&workspace.join("a.txt")).expect("streams after");
    assert!(after_streams.iter().any(|(name, bytes)| name == "promo" && bytes == b"ads-bytes"));
    assert_eq!(security_digest_of(&workspace.join("a.txt")).expect("sd after"), before_sd);
}

#[test]
fn directory_replace_aborts_before_mutation() {
    let (config, workspace) = temp_config("dirmeta");
    write_base(&workspace, &[("keep.txt", b"keep")]);
    fs::create_dir(workspace.join("nested")).expect("dir");
    let store = open_store(&config);
    let expected = predicted_result_root(&workspace, "ws-dirmeta", &[("keep.txt", Some(b"keep".as_slice()))]);
    let result = apply(
        &store,
        &workspace,
        &expected,
        vec![PromotionEntry {
            kind: EntryKind::Replace,
            relative_path: "nested".into(),
            after_bytes: Some(b"nope".to_vec()),
        }],
        None,
        extras("ws-dirmeta", "nonce-dirmeta-aaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    );
    assert!(matches!(result, Err(PromotionError::Metadata(_))));
    assert_eq!(fs::read(workspace.join("keep.txt")).unwrap(), b"keep");
    assert!(workspace.join("nested").is_dir());
}

#[test]
fn crash_after_fs_before_sql_applied_recovers_candidate() {
    let (config, workspace) = temp_config("fs-sql");
    write_base(&workspace, &[("a.txt", b"base-a"), ("b.txt", b"base-b")]);
    let base = read_workspace_files(&workspace).unwrap();
    let expected = predicted_result_root(
        &workspace,
        "ws-fs-sql",
        &[
            ("a.txt", Some(b"next-a".as_slice())),
            ("b.txt", Some(b"next-b".as_slice())),
        ],
    );
    {
        let store = open_store(&config);
        let result = apply(
            &store,
            &workspace,
            &expected,
            vec![
                PromotionEntry {
                    kind: EntryKind::Replace,
                    relative_path: "a.txt".into(),
                    after_bytes: Some(b"next-a".to_vec()),
                },
                PromotionEntry {
                    kind: EntryKind::Replace,
                    relative_path: "b.txt".into(),
                    after_bytes: Some(b"next-b".to_vec()),
                },
            ],
            Some(Checkpoint::AfterFsBeforeSql(0)),
            extras("ws-fs-sql", ""),
        );
        assert!(matches!(result, Err(PromotionError::InjectedCrash(Checkpoint::AfterFsBeforeSql(0)))));
    }
    let store = open_store(&config);
    let after = read_workspace_files(&workspace).unwrap();
    let mixed = after.get("a.txt").map(Vec::as_slice) == Some(b"next-a".as_slice())
        && after.get("b.txt").map(Vec::as_slice) == Some(b"base-b".as_slice());
    let is_base = after == base;
    let is_candidate = after.get("a.txt").map(Vec::as_slice) == Some(b"next-a".as_slice())
        && after.get("b.txt").map(Vec::as_slice) == Some(b"next-b".as_slice());
    assert!(is_base || is_candidate, "must not leave mixed tree {after:?}");
    assert!(!mixed, "transaction-owned after-bytes must roll forward");
    let lease = workspace_recovery(&store, "ws-fs-sql").unwrap().unwrap();
    if !is_base {
        assert_ne!(lease.0, "STALE");
        assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"next-a");
        assert_eq!(fs::read(workspace.join("b.txt")).unwrap(), b"next-b");
    }
}

#[test]
fn deny_burns_nonce_survives_store_reopen() {
    let (config, workspace) = temp_config("deny-reopen");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let expected = predicted_result_root(&workspace, "ws-deny-reopen", &[("a.txt", Some(b"next-a".as_slice()))]);
    let nonce;
    {
        let store = open_store(&config);
        ensure_workspace(&store, "ws-deny-reopen", &workspace);
        nonce = store.open_trusted_session(CERT, CERT, LATER).expect("session").1;
        store.consume_trusted_nonce(&nonce, CERT).expect("deny consume");
    }
    let store = open_store(&config);
    assert!(store.consume_trusted_nonce(&nonce, CERT).is_err());
    let mut extra = extras("ws-deny-reopen", &nonce);
    extra.reuse_nonce = true;
    let result = apply(
        &store,
        &workspace,
        &expected,
        vec![PromotionEntry {
            kind: EntryKind::Replace,
            relative_path: "a.txt".into(),
            after_bytes: Some(b"next-a".to_vec()),
        }],
        None,
        extra,
    );
    assert!(matches!(result, Err(PromotionError::Replay)));
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
}

#[test]
fn grant_one_use_survives_store_reopen() {
    let (config, workspace) = temp_config("grant-reopen");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let expected = predicted_result_root(&workspace, "ws-grant-reopen", &[("a.txt", Some(b"next-a".as_slice()))]);
    let entries = vec![PromotionEntry {
        kind: EntryKind::Replace,
        relative_path: "a.txt".into(),
        after_bytes: Some(b"next-a".to_vec()),
    }];
    let nonce;
    let envelopes;
    {
        let store = open_store(&config);
        ensure_workspace(&store, "ws-grant-reopen", &workspace);
        nonce = store.open_trusted_session(CERT, CERT, LATER).expect("session").1;
        envelopes = signed_envelopes("workspace-promotion", LATER, &nonce, "workspace-promotion", "ENTRY_JOURNALED");
        consume_grant(&store, &envelope_object_digest(&envelopes.0).expect("digest")).expect("consume");
    }
    let store = open_store(&config);
    let mut extra = extras("ws-grant-reopen", &nonce);
    extra.reuse_nonce = true;
    extra.envelopes = Some(envelopes);
    let second = apply(&store, &workspace, &expected, entries, None, extra);
    assert!(matches!(second, Err(PromotionError::GrantConsumed)));
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
}

#[test]
fn metadata_only_ads_drift_before_mutation_is_stale() {
    let (config, workspace) = temp_config("ads-drift");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let expected = predicted_result_root(&workspace, "ws-ads-drift", &[("a.txt", Some(b"next-a".as_slice()))]);
    let store = open_store(&config);
    let mutate = |root: &Path| {
        let ads = format!("{}:promo", root.join("a.txt").display());
        fs::write(&ads, b"ads-drift").expect("ads drift");
    };
    let mut extra = extras("ws-ads-drift", "");
    extra.mutate_after_prepared = Some(&mutate);
    let outcome = apply(
        &store,
        &workspace,
        &expected,
        vec![PromotionEntry {
            kind: EntryKind::Replace,
            relative_path: "a.txt".into(),
            after_bytes: Some(b"next-a".to_vec()),
        }],
        None,
        extra,
    )
    .expect("stale");
    assert_eq!(outcome.receipt["outcome"], "STALE");
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
    let paths = outcome.receipt["affectedPaths"].as_array().expect("affected");
    assert!(paths.iter().any(|p| p["path"] == "a.txt"));
}

#[test]
fn apply_without_trusted_session_does_not_mutate() {
    let (config, workspace) = temp_config("nosession");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let expected = predicted_result_root(&workspace, "ws-nosession", &[("a.txt", Some(b"next-a".as_slice()))]);
    let store = open_store(&config);
    let mut extra = extras("ws-nosession", "missing-session-nonce-aaaaaaaaaaaaaaaaaaaa");
    extra.skip_session = true;
    let result = apply(
        &store,
        &workspace,
        &expected,
        vec![PromotionEntry {
            kind: EntryKind::Replace,
            relative_path: "a.txt".into(),
            after_bytes: Some(b"next-a".to_vec()),
        }],
        None,
        extra,
    );
    assert!(matches!(result, Err(PromotionError::Replay)));
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
}

#[test]
fn missing_hello_fail_closes_when_presence_is_not_injected() {
    let result = request_platform_assertion_timed(CERT, 1);
    assert!(result.is_err(), "missing Hello must not count as presence");
}

#[test]
fn expected_snapshot_root_mismatch_is_not_committed() {
    let (config, workspace) = temp_config("snap-mismatch");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let store = open_store(&config);
    let outcome = apply(
        &store,
        &workspace,
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        vec![PromotionEntry {
            kind: EntryKind::Replace,
            relative_path: "a.txt".into(),
            after_bytes: Some(b"next-a".to_vec()),
        }],
        None,
        extras("ws-snap-mismatch", ""),
    )
    .expect("terminal");
    assert_ne!(outcome.receipt["outcome"], "COMMITTED");
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
}

#[test]
fn reconcile_snapshot_root_mismatch_is_not_committed() {
    let (config, workspace) = temp_config("reconcile-snap");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    {
        let store = open_store(&config);
        let result = apply(
            &store,
            &workspace,
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            vec![PromotionEntry {
                kind: EntryKind::Replace,
                relative_path: "a.txt".into(),
                after_bytes: Some(b"next-a".to_vec()),
            }],
            Some(Checkpoint::AfterEntry(0)),
            extras("ws-reconcile-snap", ""),
        );
        assert!(matches!(result, Err(PromotionError::InjectedCrash(Checkpoint::AfterEntry(0)))));
        assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"next-a");
    }
    let store = open_store(&config);
    reconcile_all(&store).expect("reconcile");
    let lease = workspace_recovery(&store, "ws-reconcile-snap").unwrap().unwrap();
    assert_ne!(lease.0, "COMMITTED");
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
}

#[test]
fn create_inherits_parent_dacl_not_staging() {
    let (config, workspace) = temp_config("create-dacl");
    let parent = workspace.join("protected");
    fs::create_dir(&parent).expect("parent");
    let user = current_user_sid_string().expect("sid");
    set_named_dacl(
        &parent,
        &format!("D:PAI(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)(A;OICI;GA;;;{user})"),
    );
    let staging = config.data_dir.join("acl-staging");
    fs::create_dir_all(&staging).expect("staging");
    set_named_dacl(&staging, "D:P(A;;GA;;;SY)(A;;GA;;;BA)");
    fs::write(staging.join("from-stage.txt"), b"staged").expect("staged file");
    let expected = predicted_create_root(&workspace, "ws-create-dacl", "protected/new.txt", b"created");
    let store = open_store(&config);
    let outcome = apply(
        &store,
        &workspace,
        &expected,
        vec![PromotionEntry {
            kind: EntryKind::Create,
            relative_path: "protected/new.txt".into(),
            after_bytes: Some(b"created".to_vec()),
        }],
        None,
        extras("ws-create-dacl", ""),
    )
    .expect("create");
    assert_eq!(outcome.receipt["outcome"], "COMMITTED");
    let created = parent.join("new.txt");
    assert_eq!(fs::read(&created).unwrap(), b"created");
    fs::write(parent.join("sibling.txt"), b"sib").expect("sibling");
    let inherited = security_digest_of(&created).expect("created sd");
    let sibling = security_digest_of(&parent.join("sibling.txt")).expect("sibling sd");
    let staged = security_digest_of(&staging.join("from-stage.txt")).expect("staging sd");
    assert_eq!(inherited, sibling);
    assert_ne!(inherited, staged);
}

#[test]
fn promotion_mode_mismatch_vs_signed_subject_does_not_mutate() {
    let (config, workspace) = temp_config("mode-mismatch");
    write_base(&workspace, &[("a.txt", b"base-a")]);
    let expected = predicted_result_root(&workspace, "ws-mode-mismatch", &[("a.txt", Some(b"next-a".as_slice()))]);
    let store = open_store(&config);
    let mut extra = extras("ws-mode-mismatch", "");
    extra.mode = "ROOT_SWAP";
    extra.signed_mode = "ENTRY_JOURNALED";
    let result = apply(
        &store,
        &workspace,
        &expected,
        vec![PromotionEntry {
            kind: EntryKind::Replace,
            relative_path: "a.txt".into(),
            after_bytes: Some(b"next-a".to_vec()),
        }],
        None,
        extra,
    );
    assert!(matches!(result, Err(PromotionError::SubjectMismatch)));
    assert_eq!(fs::read(workspace.join("a.txt")).unwrap(), b"base-a");
}
