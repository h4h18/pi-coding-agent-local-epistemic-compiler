#![allow(clippy::unnecessary_cast)]
#![allow(clippy::collapsible_if)]

use crate::config::RunnerError;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;
use std::sync::Mutex as ProfileMutex;
use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_PRIVILEGE_NOT_HELD, HANDLE, LUID, WAIT_OBJECT_0,
};
use windows::Win32::Security::{
    AdjustTokenPrivileges, CreateRestrictedToken, GetTokenInformation, LookupPrivilegeValueW,
    TokenUser, LUID_AND_ATTRIBUTES, PSID, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES, TOKEN_PRIVILEGES,
    TOKEN_USER, DISABLE_MAX_PRIVILEGE, SE_ASSIGNPRIMARYTOKEN_NAME, SE_IMPERSONATE_NAME,
    SE_INCREASE_QUOTA_NAME, SE_PRIVILEGE_ENABLED, TOKEN_ALL_ACCESS, TOKEN_ASSIGN_PRIMARY,
    TOKEN_DUPLICATE, TOKEN_QUERY, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID,
};
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, CreateProcessWithTokenW, DeleteProcThreadAttributeList,
    InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetExitCodeProcess, LOGON_NETCREDENTIALS_ONLY,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    STARTUPINFOEXW, STARTUPINFOW,
};

const APPCONTAINER_NAME: &str = "pi.hec.broker.pi";
const APPCONTAINER_DISPLAY: &str = "Pi HEC confined client";
const APPCONTAINER_DESC: &str = "Restricted Pi client of the HEC broker";

pub struct BrokerJob {
    handle: HANDLE,
}

unsafe impl Send for BrokerJob {}
unsafe impl Sync for BrokerJob {}

impl BrokerJob {
    pub fn create() -> Result<Self, RunnerError> {
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null())
                .map_err(|_| RunnerError::Launch("CreateJobObjectW"))?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = 16;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|_| RunnerError::Launch("SetInformationJobObject"))?;
            Ok(Self { handle })
        }
    }

    pub fn handle(&self) -> HANDLE {
        self.handle
    }

    pub fn contains_process(&self, process: HANDLE) -> Result<bool, RunnerError> {
        let mut inside = BOOL(0);
        unsafe {
            IsProcessInJob(process, Some(self.handle), &mut inside)
                .map_err(|_| RunnerError::Launch("IsProcessInJob"))?;
        }
        Ok(inside.as_bool())
    }
}

impl Drop for BrokerJob {
    fn drop(&mut self) {
        unsafe {
            if !self.handle.is_invalid() {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

pub struct ConfinedChild {
    pub process_id: u32,
    process: HANDLE,
    thread: HANDLE,
}

unsafe impl Send for ConfinedChild {}
unsafe impl Sync for ConfinedChild {}

impl ConfinedChild {
    pub fn wait_ms(&self, millis: u32) -> Result<bool, RunnerError> {
        unsafe {
            let status = WaitForSingleObject(self.process, millis);
            Ok(status == WAIT_OBJECT_0)
        }
    }

    pub fn process_handle(&self) -> HANDLE {
        self.process
    }

    pub fn exit_code(&self) -> Result<u32, RunnerError> {
        let mut code = 0u32;
        unsafe {
            GetExitCodeProcess(self.process, &mut code)
                .map_err(|_| RunnerError::Launch("GetExitCodeProcess"))?;
        }
        Ok(code)
    }
}

impl Drop for ConfinedChild {
    fn drop(&mut self) {
        unsafe {
            if !self.thread.is_invalid() {
                let _ = CloseHandle(self.thread);
            }
            if !self.process.is_invalid() {
                let _ = CloseHandle(self.process);
            }
        }
    }
}

pub fn launch_confined(
    job: &BrokerJob,
    executable: &Path,
    args: &[impl AsRef<OsStr>],
) -> Result<ConfinedChild, RunnerError> {
    let mut command = quote_arg(executable.as_os_str());
    for arg in args {
        command.push(' ');
        command.push_str(&quote_arg(arg.as_ref()));
    }
    let command_wide: Vec<u16> = OsStr::new(&command).encode_wide().chain(Some(0)).collect();
    let app_wide: Vec<u16> = executable.as_os_str().encode_wide().chain(Some(0)).collect();

    unsafe {
        let mut primary = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE
                | TOKEN_QUERY
                | TOKEN_ASSIGN_PRIMARY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID
                | TOKEN_ADJUST_PRIVILEGES
                | TOKEN_ALL_ACCESS,
            &mut primary,
        )
        .map_err(|_| RunnerError::Launch("OpenProcessToken"))?;
        enable_launch_privileges(primary);
        let (user_buf, user_sid) = token_user_sid(primary)?;
        let restricting = [SID_AND_ATTRIBUTES {
            Sid: user_sid,
            Attributes: 0,
        }];
        let mut restricted = HANDLE::default();
        CreateRestrictedToken(
            primary,
            DISABLE_MAX_PRIVILEGE,
            None,
            None,
            Some(&restricting),
            &mut restricted,
        )
        .map_err(|_| RunnerError::Launch("CreateRestrictedToken"))?;
        let _ = user_buf;

        let container_sid = ensure_appcontainer_profile()?;
        let mut capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: container_sid,
            Capabilities: ptr::null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };

        let mut attr_size = 0usize;
        let _ = InitializeProcThreadAttributeList(None, 1, Some(0), &mut attr_size);
        if attr_size == 0 {
            return Err(RunnerError::Launch("InitializeProcThreadAttributeList size"));
        }
        let mut attr_buf = vec![0u8; attr_size];
        InitializeProcThreadAttributeList(
            Some(LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr().cast())),
            1,
            Some(0),
            &mut attr_size,
        )
        .map_err(|_| RunnerError::Launch("InitializeProcThreadAttributeList"))?;
        UpdateProcThreadAttribute(
            LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr().cast()),
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            Some((&raw mut capabilities).cast()),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
        .map_err(|_| RunnerError::Launch("UpdateProcThreadAttribute"))?;

        let mut siex = STARTUPINFOEXW::default();
        siex.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        siex.lpAttributeList = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr().cast());

        let mut info = PROCESS_INFORMATION::default();
        let flags = CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
        let startup = (&raw const siex as *const STARTUPINFOEXW).cast::<STARTUPINFOW>();
        let mut command_as_user = command_wide.clone();
        let mut created = CreateProcessAsUserW(
            Some(restricted),
            PCWSTR(app_wide.as_ptr()),
            Some(PWSTR(command_as_user.as_mut_ptr())),
            None,
            None,
            false,
            flags,
            None,
            None,
            startup,
            &mut info,
        );
        if let Err(error) = &created {
            if error.code() == ERROR_PRIVILEGE_NOT_HELD.to_hresult() {
                let mut command_token = command_wide.clone();
                created = CreateProcessWithTokenW(
                    restricted,
                    LOGON_NETCREDENTIALS_ONLY,
                    PCWSTR(app_wide.as_ptr()),
                    Some(PWSTR(command_token.as_mut_ptr())),
                    flags,
                    None,
                    PCWSTR::null(),
                    startup,
                    &mut info,
                );
            }
        }
        DeleteProcThreadAttributeList(LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr().cast()));
        let _ = CloseHandle(primary);
        let _ = CloseHandle(restricted);
        created.map_err(|error| {
            RunnerError::Io(std::io::Error::other(format!(
                "restricted CreateProcess: {error}"
            )))
        })?;

        let assigned = AssignProcessToJobObject(job.handle(), info.hProcess);
        if assigned.is_err() {
            let _ = TerminateProcess(info.hProcess, 1);
            let _ = CloseHandle(info.hThread);
            let _ = CloseHandle(info.hProcess);
            return Err(RunnerError::Launch("AssignProcessToJobObject"));
        }
        let identity = super::inspect_open_process(info.dwProcessId, info.hProcess, job.handle());
        match identity {
            Ok(id) if id.has_restrictions => {}
            Ok(_) | Err(_) => {
                let _ = TerminateProcess(info.hProcess, 1);
                let _ = CloseHandle(info.hThread);
                let _ = CloseHandle(info.hProcess);
                return Err(RunnerError::Launch("child token is not restricted"));
            }
        }
        if ResumeThread(info.hThread) == u32::MAX {
            let _ = TerminateProcess(info.hProcess, 1);
            let _ = CloseHandle(info.hThread);
            let _ = CloseHandle(info.hProcess);
            return Err(RunnerError::Launch("ResumeThread"));
        }
        Ok(ConfinedChild {
            process_id: info.dwProcessId,
            process: info.hProcess,
            thread: info.hThread,
        })
    }
}

fn enable_launch_privileges(token: HANDLE) {
    unsafe {
        for name in [SE_INCREASE_QUOTA_NAME, SE_ASSIGNPRIMARYTOKEN_NAME, SE_IMPERSONATE_NAME] {
            let mut luid = LUID::default();
            if LookupPrivilegeValueW(None, name, &mut luid).is_err() {
                continue;
            }
            let state = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES {
                    Luid: luid,
                    Attributes: SE_PRIVILEGE_ENABLED,
                }],
            };
            let _ = AdjustTokenPrivileges(
                token,
                false,
                Some(ptr::from_ref(&state)),
                0,
                None,
                None,
            );
        }
    }
}

fn token_user_sid(token: HANDLE) -> Result<(Vec<u8>, PSID), RunnerError> {
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
        .map_err(|_| RunnerError::Launch("TokenUser"))?;
        let user = buf.as_ptr().cast::<TOKEN_USER>().read_unaligned();
        let sid = user.User.Sid;
        Ok((buf, sid))
    }
}

static APPCONTAINER_PROFILE: ProfileMutex<()> = ProfileMutex::new(());

pub(crate) fn appcontainer_sid() -> Result<PSID, RunnerError> {
    let name = wide(APPCONTAINER_NAME);
    unsafe {
        DeriveAppContainerSidFromAppContainerName(PCWSTR(name.as_ptr()))
            .map_err(|_| RunnerError::Launch("DeriveAppContainerSidFromAppContainerName"))
    }
}

fn ensure_appcontainer_profile() -> Result<PSID, RunnerError> {
    let _guard = APPCONTAINER_PROFILE
        .lock()
        .map_err(|_| RunnerError::Launch("appcontainer profile mutex"))?;
    let name = wide(APPCONTAINER_NAME);
    let display = wide(APPCONTAINER_DISPLAY);
    let descr = wide(APPCONTAINER_DESC);
    unsafe {
        match CreateAppContainerProfile(
            PCWSTR(name.as_ptr()),
            PCWSTR(display.as_ptr()),
            PCWSTR(descr.as_ptr()),
            None,
        ) {
            Ok(sid) => Ok(sid),
            Err(error) => {
                if error.code() == ERROR_ALREADY_EXISTS.to_hresult() {
                    appcontainer_sid()
                } else {
                    appcontainer_sid().or(Err(RunnerError::Launch("CreateAppContainerProfile")))
                }
            }
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn quote_arg(value: &OsStr) -> String {
    let raw = value.to_string_lossy();
    if raw.is_empty() {
        return "\"\"".to_string();
    }
    if !raw.contains([' ', '\t', '"']) {
        return raw.into_owned();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0u32;
    for ch in raw.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                for _ in 0..(backslashes * 2 + 1) {
                    out.push('\\');
                }
                out.push('"');
                backslashes = 0;
            }
            _ => {
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    for _ in 0..(backslashes * 2) {
        out.push('\\');
    }
    out.push('"');
    out
}
