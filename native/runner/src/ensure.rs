use crate::api_client::ApiClient;
use crate::config::{RunnerConfig, RunnerError, new_prefixed_id, sha256_digest_tagged};
use crate::local_store::LocalStore;
use crate::workspace::{
    WorkspaceBind, choose_ids, fingerprint, paths_equivalent, resolve_observed_root,
};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

#[derive(Debug)]
pub enum EnsureOutcome {
    Ready(WorkspaceBind),
    CeremonyRequired {
        bind: WorkspaceBind,
        step: &'static str,
        nonce: String,
    },
    BlockedNoGit,
}

pub async fn ensure_observed_workspace(
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
    config: &RunnerConfig,
    observed: &Path,
    approved: bool,
    nonce: Option<&str>,
) -> Result<EnsureOutcome, RunnerError> {
    let observed = match resolve_observed_root(observed) {
        Ok(root) => root,
        Err(RunnerError::BlockedNoGit) => return Ok(EnsureOutcome::BlockedNoGit),
        Err(error) => return Err(error),
    };
    if let Some(token) = nonce {
        if approved {
            store.consume_trusted_nonce(token, &sha256_digest_tagged(b"ensure-approve"))?;
        } else {
            return Ok(EnsureOutcome::CeremonyRequired {
                bind: bind_from_observed(&observed, "pending", "pending", "CEREMONY"),
                step: "project-trust",
                nonce: token.to_string(),
            });
        }
    }
    let matches = store
        .lookup_workspaces_by_identity(&observed.volume_identity, &observed.root_file_identity)?;
    if let Some((workspace_id, project_id, recovery)) = matches.into_iter().next() {
        let stored_root = store.decrypt_root_path(&workspace_id)?;
        let bind = WorkspaceBind {
            workspace_id: workspace_id.clone(),
            project_id: project_id.clone(),
            alias: store
                .workspace_alias(&workspace_id)?
                .unwrap_or_else(|| observed.alias.clone()),
            canonical_root: observed.canonical_root.clone(),
            volume_identity: observed.volume_identity.clone(),
            root_file_identity: observed.root_file_identity.clone(),
            recovery_state: recovery.clone(),
        };
        if let Some(existing) = stored_root
            && !paths_equivalent(&existing, &observed.canonical_root)
        {
            if approved {
                complete_control_ceremony(store, api, config, &bind, true).await?;
                store.update_workspace_root_after_grant(
                    &workspace_id,
                    &observed.canonical_root,
                    &observed.volume_identity,
                    &observed.root_file_identity,
                )?;
                store.put_workspace_alias(&workspace_id, &bind.alias)?;
                return Ok(EnsureOutcome::Ready(WorkspaceBind {
                    recovery_state: "READY".into(),
                    ..bind
                }));
            }
            let nonce = open_ensure_nonce(store, &bind)?;
            return Ok(EnsureOutcome::CeremonyRequired {
                bind,
                step: "workspace-registration",
                nonce,
            });
        }
        if recovery != "READY" {
            return Err(RunnerError::Reconciling);
        }
        if env_bootstrap() || api.is_none() {
            store.put_workspace_alias(&workspace_id, &bind.alias)?;
            return Ok(EnsureOutcome::Ready(bind));
        }
        return finish_existing(store, api, config, bind, approved).await;
    }
    let (project_id, workspace_id) = choose_ids(&observed);
    let bind = bind_from_observed(&observed, &workspace_id, &project_id, "READY");
    if env_bootstrap() {
        if let Some(existing) = env_session_bind(store)? {
            return Ok(EnsureOutcome::Ready(existing));
        }
        register_local(store, &bind)?;
        return Ok(EnsureOutcome::Ready(bind));
    }
    if !approved {
        if let Some(ready) = try_quiet_ready(store, api, config, &bind).await? {
            return Ok(EnsureOutcome::Ready(ready));
        }
        let nonce = open_ensure_nonce(store, &bind)?;
        return Ok(EnsureOutcome::CeremonyRequired {
            bind,
            step: "project-trust",
            nonce,
        });
    }
    complete_control_ceremony(store, api, config, &bind, false).await?;
    register_local(store, &bind)?;
    Ok(EnsureOutcome::Ready(bind))
}

pub fn env_bootstrap() -> bool {
    std::env::var("PI_HEC_WORKSPACE_ID")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

pub fn env_session_bind(store: &LocalStore) -> Result<Option<WorkspaceBind>, RunnerError> {
    let Ok(workspace_id) = std::env::var("PI_HEC_WORKSPACE_ID") else {
        return Ok(None);
    };
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Ok(None);
    }
    let Some((id, project_id, recovery)) = store.lookup_workspace(workspace_id)? else {
        return Ok(None);
    };
    let root = store.decrypt_root_path(&id)?.unwrap_or_default();
    Ok(Some(WorkspaceBind {
        workspace_id: id,
        project_id,
        alias: store
            .workspace_alias(workspace_id)?
            .or_else(|| std::env::var("PI_HEC_WORKSPACE_ALIAS").ok())
            .unwrap_or_else(|| workspace_id.to_string()),
        canonical_root: root,
        volume_identity: std::env::var("PI_HEC_VOLUME_IDENTITY").unwrap_or_default(),
        root_file_identity: std::env::var("PI_HEC_ROOT_FILE_IDENTITY").unwrap_or_default(),
        recovery_state: recovery,
    }))
}

fn bind_from_observed(
    observed: &crate::workspace::ObservedRoot,
    workspace_id: &str,
    project_id: &str,
    recovery: &str,
) -> WorkspaceBind {
    WorkspaceBind {
        workspace_id: workspace_id.to_string(),
        project_id: project_id.to_string(),
        alias: observed.alias.clone(),
        canonical_root: observed.canonical_root.clone(),
        volume_identity: observed.volume_identity.clone(),
        root_file_identity: observed.root_file_identity.clone(),
        recovery_state: recovery.to_string(),
    }
}

fn open_ensure_nonce(store: &LocalStore, bind: &WorkspaceBind) -> Result<String, RunnerError> {
    let challenge = sha256_digest_tagged(
        format!(
            "ensure:{}:{}:{}",
            bind.canonical_root, bind.volume_identity, bind.root_file_identity
        )
        .as_bytes(),
    );
    let subject = sha256_digest_tagged(bind.workspace_id.as_bytes());
    let expires =
        crate::config::unix_millis_to_rfc3339(crate::config::unix_millis_now()? + 3_600_000);
    Ok(store
        .open_trusted_session(&challenge, &subject, &expires)?
        .1)
}

async fn finish_existing(
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
    config: &RunnerConfig,
    bind: WorkspaceBind,
    approved: bool,
) -> Result<EnsureOutcome, RunnerError> {
    match try_quiet_ready(store, api, config, &bind).await? {
        Some(ready) => Ok(EnsureOutcome::Ready(ready)),
        None if approved => {
            complete_control_ceremony(store, api, config, &bind, false).await?;
            register_local(store, &bind)?;
            Ok(EnsureOutcome::Ready(bind))
        }
        None => {
            let nonce = open_ensure_nonce(store, &bind)?;
            Ok(EnsureOutcome::CeremonyRequired {
                bind,
                step: "project-trust",
                nonce,
            })
        }
    }
}

async fn try_quiet_ready(
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
    config: &RunnerConfig,
    bind: &WorkspaceBind,
) -> Result<Option<WorkspaceBind>, RunnerError> {
    let Some(api) = api else {
        if store.lookup_workspace(&bind.workspace_id)?.is_some() {
            return Ok(Some(bind.clone()));
        }
        return Ok(None);
    };
    let project = api.get_project(store, &bind.project_id).await?;
    if project.status == 404 {
        return Ok(None);
    }
    if project.status >= 400 {
        return Err(RunnerError::Http("getProject"));
    }
    let body = project.json()?;
    if body.get("trustState").and_then(Value::as_str) != Some("trusted") {
        return Ok(None);
    }
    if store.lookup_workspace(&bind.workspace_id)?.is_none() {
        return Ok(None);
    }
    let _ = config;
    Ok(Some(bind.clone()))
}

async fn complete_control_ceremony(
    store: &Arc<LocalStore>,
    api: Option<&ApiClient>,
    config: &RunnerConfig,
    bind: &WorkspaceBind,
    already_registered: bool,
) -> Result<(), RunnerError> {
    let Some(api) = api else {
        return Ok(());
    };
    let mut project = api.get_project(store, &bind.project_id).await?;
    if project.status == 404 {
        let op = new_prefixed_id("op_")?;
        project = api
            .enroll_project(store, &op, &bind.project_id, &bind.alias)
            .await?;
        if project.status != 201 && project.status != 200 {
            return Err(RunnerError::Http("enrollProject"));
        }
        project = api.get_project(store, &bind.project_id).await?;
    }
    if project.status >= 400 {
        return Err(RunnerError::Http("getProject"));
    }
    let body = project.json()?;
    let etag = project
        .header("etag")
        .ok_or(RunnerError::Http("project etag"))?
        .to_string();
    let trusted = body.get("trustState").and_then(Value::as_str) == Some("trusted");
    let mut if_match = etag;
    if !trusted {
        let approval = new_prefixed_id("approval_")?;
        let op = new_prefixed_id("op_")?;
        let trusted_http = api
            .set_project_trust(store, &op, &bind.project_id, &approval, &if_match)
            .await?;
        if trusted_http.status >= 400 {
            return Err(RunnerError::Http("setProjectTrust"));
        }
        if_match = trusted_http.header("etag").unwrap_or(&if_match).to_string();
    }
    let grant_op = new_prefixed_id("op_")?;
    let grant_approval = new_prefixed_id("approval_")?;
    let granted = api
        .grant_runner_project(
            store,
            &grant_op,
            &bind.project_id,
            &config.runner_id,
            &grant_approval,
            &if_match,
        )
        .await?;
    if granted.status != 200 && granted.status != 201 {
        return Err(RunnerError::Http("grantRunnerProject"));
    }
    if let Some(etag) = granted.header("etag") {
        if_match = etag.to_string();
    }
    let attestation = serde_json::json!({
        "kind": "workspace-registration",
        "canonicalRoot": bind.canonical_root,
        "volumeIdentity": bind.volume_identity,
        "rootFileIdentity": bind.root_file_identity,
        "runnerId": config.runner_id,
        "platform": "windows"
    });
    let bytes = crate::config::canonical_json(&attestation)?;
    let digest = sha256_digest_tagged(&bytes);
    let blob_op = new_prefixed_id("op_")?;
    let stored = api
        .put_blob(store, &blob_op, &bind.project_id, &digest, &bytes)
        .await?;
    if stored.status != 201 && stored.status != 204 {
        return Err(RunnerError::Http("putBlob attestation"));
    }
    let ws_op = new_prefixed_id("op_")?;
    let ws_approval = new_prefixed_id("approval_")?;
    let created = api
        .create_workspace(
            store,
            &ws_op,
            &bind.project_id,
            &bind.workspace_id,
            &config.runner_id,
            &fingerprint(
                &bind.volume_identity,
                &bind.root_file_identity,
                &bind.canonical_root,
            ),
            &digest,
            &ws_approval,
            &if_match,
        )
        .await?;
    if created.status != 201 && created.status != 200 && created.status != 409 {
        return Err(RunnerError::Http("createWorkspace"));
    }
    if !already_registered && store.lookup_workspace(&bind.workspace_id)?.is_none() {
        register_local(store, bind)?;
    }
    Ok(())
}

fn register_local(store: &LocalStore, bind: &WorkspaceBind) -> Result<(), RunnerError> {
    if store.lookup_workspace(&bind.workspace_id)?.is_some() {
        store.put_workspace_alias(&bind.workspace_id, &bind.alias)?;
        return Ok(());
    }
    store.register_workspace(
        &bind.workspace_id,
        &bind.project_id,
        &bind.canonical_root,
        &bind.volume_identity,
        &bind.root_file_identity,
    )?;
    store.put_workspace_alias(&bind.workspace_id, &bind.alias)?;
    Ok(())
}
