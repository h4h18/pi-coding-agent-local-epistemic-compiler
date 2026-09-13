#![allow(clippy::unnecessary_mut_passed)]

pub mod handles;
pub mod jobs;
pub mod paths;
pub mod presence;
pub mod replace;
pub mod vss;

use crate::config::{sha256_hex, unix_millis_to_rfc3339, MAX_FRAME_BYTES, PIPE_NAME_PREFIX, RunnerError};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::ptr;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::{
    GetSecurityDescriptorDacl, GetTokenInformation, TokenHasRestrictions, TokenIsAppContainer, TokenUser,
    ACL, DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, PSID, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};
use windows::Win32::System::JobObjects::IsProcessInJob;
use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

pub fn protect_data(plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, RunnerError> {
    if entropy.len() != 32 {
        return Err(RunnerError::Dpapi);
    }
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let descr: Vec<u16> = "pi-hec-runner\0".encode_utf16().collect();
    unsafe {
        CryptProtectData(
            &mut input,
            PCWSTR(descr.as_ptr()),
            Some(&entropy_blob),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| RunnerError::Dpapi)?;
    }
    let protected = unsafe { blob_to_vec(&output) };
    unsafe { free_blob(&output) };
    Ok(protected)
}

pub fn unprotect_data(ciphertext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, RunnerError> {
    if entropy.len() != 32 {
        return Err(RunnerError::Dpapi);
    }
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &mut input,
            None,
            Some(&entropy_blob),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| RunnerError::Dpapi)?;
    }
    let mut plain = unsafe { blob_to_vec(&output) };
    unsafe {
        if !output.pbData.is_null() && output.cbData > 0 {
            ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        }
        free_blob(&output);
    }
    if plain.is_empty() && !ciphertext.is_empty() {
        return Err(RunnerError::Dpapi);
    }
    Ok(std::mem::take(&mut plain))
}

unsafe fn blob_to_vec(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if blob.pbData.is_null() || blob.cbData == 0 {
        return Vec::new();
    }
    unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() }
}

unsafe fn free_blob(blob: &CRYPT_INTEGER_BLOB) {
    if !blob.pbData.is_null() {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut std::ffi::c_void)));
        }
    }
}

pub fn current_user_sid_hash() -> Result<String, RunnerError> {
    Ok(sha256_hex(current_user_sid_string()?.as_bytes()))
}

pub fn pipe_name() -> Result<String, RunnerError> {
    Ok(format!("{}{}", PIPE_NAME_PREFIX, current_user_sid_hash()?))
}

pub fn create_broker_pipe(name: &str, first_instance: bool) -> Result<NamedPipeServer, RunnerError> {
    let user = current_user_sid_string()?;
    let sddl = format!("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{user})(A;;GA;;;AC)");
    let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(|_| RunnerError::Launch("pipe DACL"))?;
        let mut attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: BOOL(0),
        };
        let mut options = ServerOptions::new();
        options
            .reject_remote_clients(true)
            .pipe_mode(tokio::net::windows::named_pipe::PipeMode::Byte)
            .in_buffer_size(MAX_FRAME_BYTES)
            .out_buffer_size(MAX_FRAME_BYTES);
        if first_instance {
            options.first_pipe_instance(true);
        }
        let created =
            options.create_with_security_attributes_raw(name, ptr::from_mut(&mut attrs).cast());
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        created.map_err(RunnerError::Io)
    }
}

pub fn current_process_token() -> Result<HANDLE, RunnerError> {
    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY,
            &mut token,
        )
        .map_err(|_| RunnerError::Identity("OpenProcessToken"))?;
    }
    Ok(token)
}

fn token_user_sid_string(token: HANDLE) -> Result<String, RunnerError> {
    let mut needed = 0u32;
    unsafe {
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        let mut buf = vec![0u8; needed as usize];
        GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
        .map_err(|_| RunnerError::Identity("TokenUser"))?;
        let user = buf.as_ptr().cast::<TOKEN_USER>().read_unaligned();
        sid_to_string(user.User.Sid)
    }
}

pub(crate) fn sid_to_string(sid: PSID) -> Result<String, RunnerError> {
    let mut raw = PWSTR::null();
    unsafe {
        ConvertSidToStringSidW(sid, &mut raw).map_err(|_| RunnerError::Identity("ConvertSidToStringSidW"))?;
        let text = raw.to_string().map_err(|_| RunnerError::Identity("sid utf16"))?;
        let _ = LocalFree(Some(HLOCAL(raw.0 as *mut std::ffi::c_void)));
        Ok(text)
    }
}

pub fn named_pipe_client_pid<H: AsRawHandle>(pipe: &H) -> Result<u32, RunnerError> {
    let handle = HANDLE(pipe.as_raw_handle());
    let mut pid = 0u32;
    unsafe {
        GetNamedPipeClientProcessId(handle, &mut pid)
            .map_err(|_| RunnerError::Handshake("GetNamedPipeClientProcessId"))?;
    }
    if pid == 0 {
        return Err(RunnerError::Handshake("client pid was zero"));
    }
    Ok(pid)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub process_id: u32,
    pub creation_time: String,
    pub user_sid: String,
    pub is_app_container: bool,
    pub has_restrictions: bool,
    pub in_broker_job: bool,
}

pub fn inspect_client_process(pid: u32, job: HANDLE) -> Result<ProcessIdentity, RunnerError> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|_| RunnerError::Handshake("OpenProcess"))?;
        let identity = inspect_open_process(pid, process, job);
        let _ = CloseHandle(process);
        identity
    }
}

pub(crate) fn inspect_open_process(pid: u32, process: HANDLE, job: HANDLE) -> Result<ProcessIdentity, RunnerError> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token)
            .map_err(|_| RunnerError::Handshake("OpenProcessToken client"))?;
        let mut creation = windows::Win32::Foundation::FILETIME::default();
        let mut exit = windows::Win32::Foundation::FILETIME::default();
        let mut kernel = windows::Win32::Foundation::FILETIME::default();
        let mut user = windows::Win32::Foundation::FILETIME::default();
        GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user)
            .map_err(|_| RunnerError::Handshake("GetProcessTimes"))?;
        let mut in_job = BOOL(0);
        IsProcessInJob(process, Some(job), &mut in_job)
            .map_err(|_| RunnerError::Handshake("IsProcessInJob"))?;
        let user_sid = token_user_sid_string(token)?;
        let is_app_container = token_u32(token, TokenIsAppContainer)? != 0;
        let has_restrictions = token_u32(token, TokenHasRestrictions)? != 0;
        let _ = CloseHandle(token);
        Ok(ProcessIdentity {
            process_id: pid,
            creation_time: filetime_to_rfc3339(creation)?,
            user_sid,
            is_app_container,
            has_restrictions,
            in_broker_job: in_job.as_bool(),
        })
    }
}

fn token_u32(
    token: HANDLE,
    class: windows::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> Result<u32, RunnerError> {
    let mut value = 0u32;
    let mut needed = 0u32;
    unsafe {
        GetTokenInformation(
            token,
            class,
            Some((&mut value as *mut u32).cast()),
            std::mem::size_of::<u32>() as u32,
            &mut needed,
        )
        .map_err(|_| RunnerError::Handshake("GetTokenInformation"))?;
    }
    Ok(value)
}

pub fn filetime_to_rfc3339(ft: windows::Win32::Foundation::FILETIME) -> Result<String, RunnerError> {
    let ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    const EPOCH_DIFF: u64 = 11_644_473_600_000_000;
    let unix_100ns = ticks.saturating_sub(EPOCH_DIFF * 10);
    let unix_ms = unix_100ns / 10_000;
    Ok(unix_millis_to_rfc3339(unix_ms))
}

pub fn current_user_sid_string() -> Result<String, RunnerError> {
    let token = current_process_token()?;
    let text = token_user_sid_string(token)?;
    unsafe {
        let _ = CloseHandle(token);
    }
    Ok(text)
}

pub fn sids_equal(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

pub fn load_or_create_entropy(path: &std::path::Path) -> Result<[u8; 32], RunnerError> {
    if path.exists() {
        let bytes = std::fs::read(path)?;
        if bytes.len() != 32 {
            return Err(RunnerError::Dpapi);
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        apply_broker_file_dacl(path)?;
        return Ok(out);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = crate::config::random_bytes::<32>()?;
    std::fs::write(path, bytes)?;
    apply_broker_file_dacl(path)?;
    Ok(bytes)
}

fn apply_broker_file_dacl(path: &std::path::Path) -> Result<(), RunnerError> {
    let user = current_user_sid_string()?;
    let sddl = format!("D:(D;;GA;;;AC)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{user})");
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
        .map_err(|_| RunnerError::Launch("file DACL"))?;
        let mut present = BOOL(0);
        let mut defaulted = BOOL(0);
        let mut dacl: *mut ACL = ptr::null_mut();
        if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted).is_err()
            || !present.as_bool()
            || dacl.is_null()
        {
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            return Err(RunnerError::Launch("file DACL present"));
        }
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
        if status == windows::Win32::Foundation::ERROR_SUCCESS {
            Ok(())
        } else {
            Err(RunnerError::Launch("SetNamedSecurityInfoW"))
        }
    }
}

pub fn validate_confined_client(
    identity: &ProcessIdentity,
    claimed_pid: u64,
    claimed_creation_time: &str,
) -> Result<(), RunnerError> {
    let broker_sid = current_user_sid_string()?;
    if !sids_equal(&identity.user_sid, &broker_sid) {
        return Err(RunnerError::Handshake("client SID mismatch"));
    }
    if !identity.is_app_container {
        return Err(RunnerError::Handshake("client is not AppContainer"));
    }
    if !identity.has_restrictions {
        return Err(RunnerError::Handshake("client is not a restricted token"));
    }
    if !identity.in_broker_job {
        return Err(RunnerError::Handshake("client is not in broker Job"));
    }
    if u64::from(identity.process_id) != claimed_pid {
        return Err(RunnerError::ClaimMismatch);
    }
    if identity.creation_time != claimed_creation_time {
        return Err(RunnerError::ClaimMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{filetime_to_rfc3339, protect_data, unprotect_data};
    use windows::Win32::Foundation::FILETIME;

    #[test]
    fn dpapi_round_trips_and_changes_bytes() {
        let plain = b"pi-hec-secret-material-32b!!!!";
        let entropy = [7u8; 32];
        let wrapped = protect_data(plain, &entropy).expect("protect");
        assert_ne!(wrapped.as_slice(), plain);
        let opened = unprotect_data(&wrapped, &entropy).expect("unprotect");
        assert_eq!(opened.as_slice(), plain);
        assert!(unprotect_data(&wrapped, &[0u8; 32]).is_err());
    }

    #[test]
    fn filetime_unix_epoch_is_1970() {
        const EPOCH: u64 = 116444736000000000;
        let ft = FILETIME {
            dwLowDateTime: (EPOCH & 0xffff_ffff) as u32,
            dwHighDateTime: (EPOCH >> 32) as u32,
        };
        assert_eq!(filetime_to_rfc3339(ft).unwrap(), "1970-01-01T00:00:00.000Z");
    }
}
