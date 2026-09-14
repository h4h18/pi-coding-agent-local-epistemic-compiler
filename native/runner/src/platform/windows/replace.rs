use crate::config::sha256_digest_tagged;
use crate::windows::handles::{
    OpenedFile, inspect_handle, open_deny_write_handle, open_reparse_handle, read_handle_bytes,
    read_named_stream,
};
use crate::windows::paths::{to_extended_path, to_wide};
use base64::Engine;
use serde_json::{Value, json};
use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use windows::Win32::Foundation::{CloseHandle, GENERIC_WRITE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SE_FILE_OBJECT, SetNamedSecurityInfoW,
};
use windows::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetSecurityDescriptorDacl,
    GetSecurityDescriptorGroup, GetSecurityDescriptorOwner, GetSecurityDescriptorSacl,
    LABEL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_DESCRIPTOR,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, DeleteFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE, FlushFileBuffers,
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW, OPEN_EXISTING,
};
use windows::core::{BOOL, PCWSTR};

#[derive(Debug)]
pub enum ReplaceError {
    Io(std::io::Error),
    Metadata(&'static str),
    Volume,
}

impl std::fmt::Display for ReplaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "io: {error}"),
            Self::Metadata(msg) => write!(f, "metadata: {msg}"),
            Self::Volume => f.write_str("staging volume mismatch"),
        }
    }
}

impl std::error::Error for ReplaceError {}

impl From<std::io::Error> for ReplaceError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

fn io_from_windows(err: windows::core::Error) -> std::io::Error {
    std::io::Error::other(err.to_string())
}

#[derive(Debug, Clone)]
pub struct CapturedMetadata {
    pub security_descriptor: Vec<u8>,
    pub security_digest: String,
    pub streams: Vec<(String, Vec<u8>)>,
    pub identity: String,
    pub reparse_tag: Option<u32>,
    pub is_directory: bool,
    pub git_mode: String,
}

pub fn probe_atomic_root_switch() -> bool {
    false
}

pub fn same_volume(left: &Path, right: &Path) -> Result<bool, ReplaceError> {
    Ok(volume_root(left)? == volume_root(right)?)
}

fn volume_root(path: &Path) -> Result<String, ReplaceError> {
    let wide = to_wide(&to_extended_path(path).to_string_lossy());
    let mut buf = vec![0u16; 1024];
    unsafe {
        windows::Win32::Storage::FileSystem::GetVolumePathNameW(
            PCWSTR(wide.as_ptr()),
            buf.as_mut_slice(),
        )
    }
    .map_err(|_| ReplaceError::Volume)?;
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    Ok(String::from_utf16_lossy(&buf[..end]).to_ascii_uppercase())
}

pub fn capture_existing(path: &Path) -> Result<CapturedMetadata, ReplaceError> {
    let (meta, _handle) = capture_held(path)?;
    Ok(meta)
}

pub fn capture_held(
    path: &Path,
) -> Result<(CapturedMetadata, crate::windows::handles::FileHandle), ReplaceError> {
    let handle = open_deny_write_handle(path)
        .map_err(|err| ReplaceError::Io(std::io::Error::other(err.to_string())))?;
    let opened = inspect_handle(&handle)
        .map_err(|err| ReplaceError::Io(std::io::Error::other(err.to_string())))?;
    if opened.reparse_tag.is_some() {
        return Err(ReplaceError::Metadata("reparse blocks promotion"));
    }
    let sd = read_security_descriptor(path)?;
    if sd.is_empty() {
        return Err(ReplaceError::Metadata("security descriptor missing"));
    }
    let digest = sha256_digest_tagged(&sd);
    if digest != opened.security_descriptor_digest
        && opened.security_descriptor_digest != sha256_digest_tagged(b"")
    {
        return Err(ReplaceError::Metadata(
            "security descriptor digest mismatch",
        ));
    }
    let mut streams = Vec::new();
    for stream in &opened.streams {
        let bytes = read_named_stream(path, &stream.name)
            .map_err(|err| ReplaceError::Io(std::io::Error::other(err.to_string())))?;
        streams.push((stream.name.clone(), bytes));
    }
    Ok((
        CapturedMetadata {
            security_descriptor: sd,
            security_digest: digest,
            streams,
            identity: opened.identity.encoded(),
            reparse_tag: opened.reparse_tag,
            is_directory: opened.is_directory,
            git_mode: "100644".into(),
        },
        handle,
    ))
}

pub fn captured_to_json(meta: &CapturedMetadata) -> Value {
    json!({
        "securityDescriptor": Engine::encode(&base64::engine::general_purpose::STANDARD, &meta.security_descriptor),
        "securityDigest": meta.security_digest,
        "streams": meta.streams.iter().map(|(name, bytes)| json!({
            "name": name,
            "bytes": Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
        })).collect::<Vec<_>>(),
        "identity": meta.identity,
        "reparseTag": meta.reparse_tag,
        "isDirectory": meta.is_directory,
        "gitMode": meta.git_mode
    })
}

pub fn captured_from_json(value: &Value) -> Result<CapturedMetadata, ReplaceError> {
    let decode = |text: &str| {
        Engine::decode(&base64::engine::general_purpose::STANDARD, text)
            .map_err(|_| ReplaceError::Metadata("metadata encoding"))
    };
    let sd = decode(
        value
            .get("securityDescriptor")
            .and_then(Value::as_str)
            .ok_or(ReplaceError::Metadata("securityDescriptor"))?,
    )?;
    let mut streams = Vec::new();
    if let Some(items) = value.get("streams").and_then(Value::as_array) {
        for item in items {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .ok_or(ReplaceError::Metadata("stream name"))?
                .to_string();
            let bytes = decode(
                item.get("bytes")
                    .and_then(Value::as_str)
                    .ok_or(ReplaceError::Metadata("stream bytes"))?,
            )?;
            streams.push((name, bytes));
        }
    }
    Ok(CapturedMetadata {
        security_descriptor: sd,
        security_digest: value
            .get("securityDigest")
            .and_then(Value::as_str)
            .ok_or(ReplaceError::Metadata("securityDigest"))?
            .to_string(),
        streams,
        identity: value
            .get("identity")
            .and_then(Value::as_str)
            .ok_or(ReplaceError::Metadata("identity"))?
            .to_string(),
        reparse_tag: value
            .get("reparseTag")
            .and_then(Value::as_u64)
            .map(|v| v as u32),
        is_directory: value
            .get("isDirectory")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        git_mode: value
            .get("gitMode")
            .and_then(Value::as_str)
            .unwrap_or("100644")
            .to_string(),
    })
}

pub fn inspect_path(path: &Path) -> Result<OpenedFile, ReplaceError> {
    let handle = open_reparse_handle(path)
        .map_err(|err| ReplaceError::Io(std::io::Error::other(err.to_string())))?;
    inspect_handle(&handle).map_err(|err| ReplaceError::Io(std::io::Error::other(err.to_string())))
}

pub fn read_bytes(path: &Path) -> Result<Vec<u8>, ReplaceError> {
    let handle = open_reparse_handle(path)
        .map_err(|err| ReplaceError::Io(std::io::Error::other(err.to_string())))?;
    read_handle_bytes(&handle)
        .map_err(|err| ReplaceError::Io(std::io::Error::other(err.to_string())))
}

pub fn content_digest(bytes: &[u8]) -> String {
    sha256_digest_tagged(bytes)
}

pub fn write_staging_file(path: &Path, bytes: &[u8]) -> Result<(), ReplaceError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

pub fn apply_captured_metadata(path: &Path, meta: &CapturedMetadata) -> Result<(), ReplaceError> {
    apply_security_descriptor(path, &meta.security_descriptor)?;
    for (name, bytes) in &meta.streams {
        write_named_stream(path, name, bytes)?;
    }
    for (name, expected) in &meta.streams {
        let got = read_named_stream(path, name)
            .map_err(|err| ReplaceError::Io(std::io::Error::other(err.to_string())))?;
        if got.as_slice() != expected.as_slice() {
            return Err(ReplaceError::Metadata("unable to restore alternate stream"));
        }
    }
    Ok(())
}

pub fn in_parent_create_temp(dest: &Path) -> PathBuf {
    let file_name = dest.file_name().unwrap_or_else(|| OsStr::new("created"));
    let mut tmp_name = OsString::from(".");
    tmp_name.push(file_name);
    tmp_name.push(".pi-hec-tmp");
    match dest.parent() {
        Some(parent) => parent.join(tmp_name),
        None => PathBuf::from(tmp_name),
    }
}

pub fn atomic_replace(source: &Path, dest: &Path) -> Result<(), ReplaceError> {
    move_ex(source, dest, true)
}

pub fn atomic_rename(source: &Path, dest: &Path) -> Result<(), ReplaceError> {
    move_ex(source, dest, false)
}

fn move_ex(source: &Path, dest: &Path, replace: bool) -> Result<(), ReplaceError> {
    let src = to_wide(&to_extended_path(source).to_string_lossy());
    let dst = to_wide(&to_extended_path(dest).to_string_lossy());
    let mut flags = MOVEFILE_WRITE_THROUGH;
    if replace {
        flags |= MOVEFILE_REPLACE_EXISTING;
    }
    unsafe { MoveFileExW(PCWSTR(src.as_ptr()), PCWSTR(dst.as_ptr()), flags) }
        .map_err(|err| ReplaceError::Io(io_from_windows(err)))?;
    fsync_path(dest)?;
    if let Some(parent) = dest.parent() {
        fsync_directory(parent)?;
    }
    Ok(())
}

pub fn delete_path(path: &Path) -> Result<(), ReplaceError> {
    let wide = to_wide(&to_extended_path(path).to_string_lossy());
    unsafe { DeleteFileW(PCWSTR(wide.as_ptr())) }
        .map_err(|err| ReplaceError::Io(io_from_windows(err)))?;
    if let Some(parent) = path.parent() {
        fsync_directory(parent)?;
    }
    Ok(())
}

pub fn fsync_path(path: &Path) -> Result<(), ReplaceError> {
    if path.is_dir() {
        return fsync_directory(path);
    }
    File::options()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()?;
    Ok(())
}

pub fn fsync_directory(path: &Path) -> Result<(), ReplaceError> {
    let wide = to_wide(&to_extended_path(path).to_string_lossy());
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_GENERIC_READ.0 | GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(FILE_FLAG_BACKUP_SEMANTICS.0),
            None,
        )
    }
    .map_err(|err| ReplaceError::Io(io_from_windows(err)))?;
    let flushed = unsafe { FlushFileBuffers(handle) };
    unsafe {
        let _ = CloseHandle(handle);
    }
    flushed.map_err(|err| ReplaceError::Io(io_from_windows(err)))
}

fn write_named_stream(parent: &Path, stream_name: &str, bytes: &[u8]) -> Result<(), ReplaceError> {
    let joined = format!(
        "{}:{stream_name}",
        to_extended_path(parent).to_string_lossy()
    );
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&joined)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

fn read_security_descriptor(path: &Path) -> Result<Vec<u8>, ReplaceError> {
    let wide = to_wide(&to_extended_path(path).to_string_lossy());
    let mut sd = PSECURITY_DESCRIPTOR::default();
    let flags_with_label = OWNER_SECURITY_INFORMATION
        | GROUP_SECURITY_INFORMATION
        | DACL_SECURITY_INFORMATION
        | LABEL_SECURITY_INFORMATION;
    let flags_core =
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    let status = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            flags_with_label,
            None,
            None,
            None,
            None,
            &mut sd,
        )
    };
    let status = if status != windows::Win32::Foundation::ERROR_SUCCESS {
        unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(wide.as_ptr()),
                SE_FILE_OBJECT,
                flags_core,
                None,
                None,
                None,
                None,
                &mut sd,
            )
        }
    } else {
        status
    };
    if status != windows::Win32::Foundation::ERROR_SUCCESS {
        return Err(ReplaceError::Metadata("GetNamedSecurityInfoW"));
    }
    if sd.0.is_null() {
        return Err(ReplaceError::Metadata("null security descriptor"));
    }
    let len = unsafe { windows::Win32::Security::GetSecurityDescriptorLength(sd) };
    let bytes = unsafe { std::slice::from_raw_parts(sd.0 as *const u8, len as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(sd.0)));
    }
    if bytes.is_empty() {
        return Err(ReplaceError::Metadata("empty security descriptor"));
    }
    Ok(bytes)
}

fn apply_security_descriptor(path: &Path, sd_bytes: &[u8]) -> Result<(), ReplaceError> {
    if sd_bytes.len() < std::mem::size_of::<SECURITY_DESCRIPTOR>() {
        return Err(ReplaceError::Metadata("truncated security descriptor"));
    }
    let mut owned = sd_bytes.to_vec();
    let psd = PSECURITY_DESCRIPTOR(owned.as_mut_ptr().cast());
    let mut owner = PSID::default();
    let mut group = PSID::default();
    let mut owner_defaulted = BOOL(0);
    let mut group_defaulted = BOOL(0);
    let mut dacl_present = BOOL(0);
    let mut dacl_defaulted = BOOL(0);
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sacl_present = BOOL(0);
    let mut sacl_defaulted = BOOL(0);
    let mut sacl: *mut ACL = std::ptr::null_mut();
    unsafe {
        GetSecurityDescriptorOwner(psd, &mut owner, &mut owner_defaulted)
            .map_err(|_| ReplaceError::Metadata("GetSecurityDescriptorOwner"))?;
        GetSecurityDescriptorGroup(psd, &mut group, &mut group_defaulted)
            .map_err(|_| ReplaceError::Metadata("GetSecurityDescriptorGroup"))?;
        GetSecurityDescriptorDacl(psd, &mut dacl_present, &mut dacl, &mut dacl_defaulted)
            .map_err(|_| ReplaceError::Metadata("GetSecurityDescriptorDacl"))?;
        let _ = GetSecurityDescriptorSacl(psd, &mut sacl_present, &mut sacl, &mut sacl_defaulted);
    }
    if !dacl_present.as_bool() || dacl.is_null() {
        return Err(ReplaceError::Metadata("DACL missing"));
    }
    let wide = to_wide(&to_extended_path(path).to_string_lossy());
    let mut info =
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    if sacl_present.as_bool() && !sacl.is_null() {
        info |= LABEL_SECURITY_INFORMATION;
    }
    let status = unsafe {
        SetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            info,
            Some(owner),
            Some(group),
            Some(dacl as *const ACL),
            if sacl_present.as_bool() && !sacl.is_null() {
                Some(sacl as *const ACL)
            } else {
                None
            },
        )
    };
    if status != windows::Win32::Foundation::ERROR_SUCCESS
        && info.contains(LABEL_SECURITY_INFORMATION)
    {
        info = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
        let retry = unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(wide.as_ptr()),
                SE_FILE_OBJECT,
                info,
                Some(owner),
                Some(group),
                Some(dacl as *const ACL),
                None,
            )
        };
        if retry != windows::Win32::Foundation::ERROR_SUCCESS {
            return Err(ReplaceError::Metadata("SetNamedSecurityInfoW"));
        }
        return Ok(());
    }
    if status != windows::Win32::Foundation::ERROR_SUCCESS {
        return Err(ReplaceError::Metadata("SetNamedSecurityInfoW"));
    }
    Ok(())
}

pub fn staging_dir(workspace_root: &Path, journal_id: &str) -> PathBuf {
    match workspace_root.parent() {
        Some(parent) => parent.join(format!(".pi-hec-promote-{journal_id}")),
        None => workspace_root.join(format!(".pi-hec-promote-{journal_id}")),
    }
}
