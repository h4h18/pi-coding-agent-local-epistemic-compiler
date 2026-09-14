#![allow(clippy::unnecessary_cast)]
#![allow(clippy::collapsible_if)]

use crate::config::RunnerError;
use std::ffi::{OsStr, c_void};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;
use std::sync::Mutex as ProfileMutex;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_PRIVILEGE_NOT_HELD, ERROR_SUCCESS, HANDLE,
    HANDLE_FLAG_INHERIT, HLOCAL, LUID, LocalFree, SetHandleInformation, WAIT_OBJECT_0,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW,
    EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, SDDL_REVISION_1, SE_WINDOW_OBJECT,
    SetEntriesInAclW, SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
};
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::Win32::Security::{
    ACL, AdjustTokenPrivileges, CreateRestrictedToken, DACL_SECURITY_INFORMATION,
    DISABLE_MAX_PRIVILEGE, GetTokenInformation, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW,
    NO_INHERITANCE, PSECURITY_DESCRIPTOR, PSID, SE_ASSIGNPRIMARYTOKEN_NAME, SE_IMPERSONATE_NAME,
    SE_INCREASE_QUOTA_NAME, SE_PRIVILEGE_ENABLED, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES,
    TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID, TOKEN_ALL_ACCESS,
    TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows::Win32::Storage::FileSystem::{
    CREATE_ALWAYS, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE, FILE_SHARE_READ,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows::Win32::System::StationsAndDesktops::{
    CreateDesktopW, CreateWindowStationW, DESKTOP_CONTROL_FLAGS, GetProcessWindowStation,
    GetThreadDesktop, OpenDesktopW, OpenWindowStationW, SetProcessWindowStation,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW,
    CreateProcessWithTokenW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetCurrentProcess, GetCurrentThreadId, GetExitCodeProcess, InitializeProcThreadAttributeList,
    LOGON_NETCREDENTIALS_ONLY, LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcessToken,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{BOOL, PCWSTR, PWSTR};

const APPCONTAINER_NAME: &str = "pi.hec.broker.pi";
const APPCONTAINER_DISPLAY: &str = "Pi HEC confined client";
const APPCONTAINER_DESC: &str = "Restricted Pi client of the HEC broker";
const LOW_IL_WINSTA: &str = "pihecbk";
const LOW_IL_DESKTOP: &str = "default";

fn environment_block_with_user_sid(user_sid: &str) -> Vec<u16> {
    let mut block = Vec::new();
    let mut replaced = false;
    for (key, value) in std::env::vars_os() {
        let outgoing = if key
            .to_string_lossy()
            .eq_ignore_ascii_case("PI_HEC_USER_SID")
        {
            replaced = true;
            std::ffi::OsString::from(user_sid)
        } else {
            value
        };
        block.extend(key.encode_wide());
        block.push(u16::from(b'='));
        block.extend(outgoing.encode_wide());
        block.push(0);
    }
    if !replaced {
        block.extend(OsStr::new("PI_HEC_USER_SID").encode_wide());
        block.push(u16::from(b'='));
        block.extend(OsStr::new(user_sid).encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

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
    stdio_log: Option<&Path>,
    interactive: bool,
) -> Result<ConfinedChild, RunnerError> {
    let mut command = quote_arg(executable.as_os_str());
    for arg in args {
        command.push(' ');
        command.push_str(&quote_arg(arg.as_ref()));
    }
    let command_wide: Vec<u16> = OsStr::new(&command).encode_wide().chain(Some(0)).collect();
    let app_wide: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();

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
        let mut restricted = HANDLE::default();
        CreateRestrictedToken(
            primary,
            DISABLE_MAX_PRIVILEGE,
            None,
            None,
            None,
            &mut restricted,
        )
        .map_err(|_| RunnerError::Launch("CreateRestrictedToken"))?;
        let _ = (user_buf, user_sid);
        let launch_token = restricted;

        let container_sid = ensure_appcontainer_profile()?;
        grant_appcontainer_window_station(container_sid)?;
        let desktop_path = ensure_low_integrity_desktop(container_sid)?;
        let desktop_wide = wide(&desktop_path);
        let mut capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: container_sid,
            Capabilities: ptr::null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };

        let mut attr_size = 0usize;
        let _ = InitializeProcThreadAttributeList(None, 1, Some(0), &mut attr_size);
        if attr_size == 0 {
            return Err(RunnerError::Launch(
                "InitializeProcThreadAttributeList size",
            ));
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
        siex.StartupInfo.lpDesktop = PWSTR(desktop_wide.as_ptr() as *mut u16);
        siex.lpAttributeList = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr().cast());
        let stdio_handle = match stdio_log {
            Some(path) => Some(open_inheritable_stdio_log(path)?),
            None => None,
        };
        let inherit_handles = stdio_handle.is_some();
        if let Some(handle) = stdio_handle {
            siex.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
            siex.StartupInfo.hStdOutput = handle;
            siex.StartupInfo.hStdError = handle;
        }

        let mut info = PROCESS_INFORMATION::default();
        let user_sid = super::current_user_sid_string()?;
        let mut environment = environment_block_with_user_sid(&user_sid);
        let mut flags =
            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
        if !interactive {
            flags |= CREATE_NO_WINDOW;
        }
        let startup = (&raw const siex as *const STARTUPINFOEXW).cast::<STARTUPINFOW>();
        let mut command_as_user = command_wide.clone();
        let mut created = CreateProcessAsUserW(
            Some(launch_token),
            PCWSTR(app_wide.as_ptr()),
            Some(PWSTR(command_as_user.as_mut_ptr())),
            None,
            None,
            inherit_handles,
            flags,
            Some(environment.as_mut_ptr().cast::<c_void>()),
            None,
            startup,
            &mut info,
        );
        if let Err(error) = &created {
            if error.code() == ERROR_PRIVILEGE_NOT_HELD.to_hresult() {
                let mut command_token = command_wide.clone();
                created = CreateProcessWithTokenW(
                    launch_token,
                    LOGON_NETCREDENTIALS_ONLY,
                    PCWSTR(app_wide.as_ptr()),
                    Some(PWSTR(command_token.as_mut_ptr())),
                    flags,
                    Some(environment.as_mut_ptr().cast::<c_void>()),
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
        if let Some(handle) = stdio_handle {
            let _ = CloseHandle(handle);
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

const WINSTA_ALL_ACCESS: u32 = 0x0000_037F;
const DESKTOP_ALL_ACCESS: u32 = 0x000F_01FF;

fn ensure_low_integrity_desktop(appcontainer_sid: PSID) -> Result<String, RunnerError> {
    let ac = super::sid_to_string(appcontainer_sid)?;
    let sddl =
        format!("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;WD)(A;;GA;;;AC)(A;;GA;;;{ac})S:(ML;;NW;;;LW)");
    let sddl_wide = wide(&sddl);
    unsafe {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl_wide.as_ptr()),
            SDDL_REVISION_1,
            &mut sd,
            None,
        )
        .map_err(|_| RunnerError::Launch("low-IL security descriptor"))?;
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.0,
            bInheritHandle: false.into(),
        };
        let winsta_name = wide(LOW_IL_WINSTA);
        let desktop_name = wide(LOW_IL_DESKTOP);
        let original = GetProcessWindowStation()
            .map_err(|_| RunnerError::Launch("GetProcessWindowStation"))?;
        let winsta = match CreateWindowStationW(
            PCWSTR(winsta_name.as_ptr()),
            0,
            WINSTA_ALL_ACCESS,
            Some(ptr::from_ref(&sa)),
        ) {
            Ok(handle) => handle,
            Err(_) => OpenWindowStationW(PCWSTR(winsta_name.as_ptr()), false, WINSTA_ALL_ACCESS)
                .map_err(|_| RunnerError::Launch("OpenWindowStationW"))?,
        };
        SetProcessWindowStation(winsta)
            .map_err(|_| RunnerError::Launch("SetProcessWindowStation"))?;
        let desktop = match CreateDesktopW(
            PCWSTR(desktop_name.as_ptr()),
            PCWSTR::null(),
            None,
            DESKTOP_CONTROL_FLAGS(0),
            DESKTOP_ALL_ACCESS,
            Some(ptr::from_ref(&sa)),
        ) {
            Ok(handle) => Ok(handle),
            Err(_) => OpenDesktopW(
                PCWSTR(desktop_name.as_ptr()),
                DESKTOP_CONTROL_FLAGS(0),
                false,
                DESKTOP_ALL_ACCESS,
            ),
        };
        let restored = SetProcessWindowStation(original);
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        restored.map_err(|_| RunnerError::Launch("restore window station"))?;
        let desktop = desktop.map_err(|_| RunnerError::Launch("CreateDesktopW"))?;
        let _winsta = std::mem::ManuallyDrop::new(winsta);
        let _desktop = std::mem::ManuallyDrop::new(desktop);
    }
    Ok(format!("{LOW_IL_WINSTA}\\{LOW_IL_DESKTOP}"))
}

fn grant_appcontainer_window_station(sid: PSID) -> Result<(), RunnerError> {
    unsafe {
        let winsta = GetProcessWindowStation()
            .map_err(|_| RunnerError::Launch("GetProcessWindowStation"))?;
        let desktop = GetThreadDesktop(GetCurrentThreadId())
            .map_err(|_| RunnerError::Launch("GetThreadDesktop"))?;
        add_allowed_ace(HANDLE(winsta.0), sid, WINSTA_ALL_ACCESS)?;
        add_allowed_ace(HANDLE(desktop.0), sid, DESKTOP_ALL_ACCESS)?;
        let mut packages = PSID::default();
        ConvertStringSidToSidW(windows::core::w!("S-1-15-2-1"), &mut packages)
            .map_err(|_| RunnerError::Launch("ConvertStringSidToSidW ALL APPLICATION PACKAGES"))?;
        let grant_packages_winsta = add_allowed_ace(HANDLE(winsta.0), packages, WINSTA_ALL_ACCESS);
        let grant_packages_desktop =
            add_allowed_ace(HANDLE(desktop.0), packages, DESKTOP_ALL_ACCESS);
        let _ = LocalFree(Some(HLOCAL(packages.0)));
        grant_packages_winsta?;
        grant_packages_desktop?;
    }
    Ok(())
}

fn add_allowed_ace(handle: HANDLE, sid: PSID, access: u32) -> Result<(), RunnerError> {
    unsafe {
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        if GetSecurityInfo(
            handle,
            SE_WINDOW_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
            None,
            Some(&mut sd),
        ) != ERROR_SUCCESS
        {
            return Err(RunnerError::Launch("GetSecurityInfo window object"));
        }
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: access,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: ptr::null_mut(),
                MultipleTrusteeOperation:
                    windows::Win32::Security::Authorization::NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: PWSTR(sid.0.cast()),
            },
        };
        let mut new_dacl: *mut ACL = ptr::null_mut();
        let old_acl = if dacl.is_null() {
            None
        } else {
            Some(dacl.cast_const())
        };
        if SetEntriesInAclW(Some(&[entry]), old_acl, &mut new_dacl) != ERROR_SUCCESS {
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            return Err(RunnerError::Launch("SetEntriesInAclW window object"));
        }
        let result = SetSecurityInfo(
            handle,
            SE_WINDOW_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(new_dacl),
            None,
        );
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        let _ = LocalFree(Some(HLOCAL(new_dacl.cast())));
        if result != ERROR_SUCCESS {
            return Err(RunnerError::Launch("SetSecurityInfo window object"));
        }
        Ok(())
    }
}

fn open_inheritable_stdio_log(path: &Path) -> Result<HANDLE, RunnerError> {
    let text = path.to_str().ok_or(RunnerError::Launch("stdio log path"))?;
    let wide = wide(text);
    unsafe {
        let handle = CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_GENERIC_WRITE.0,
            FILE_SHARE_READ,
            None,
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
        .map_err(|_| RunnerError::Launch("CreateFileW stdio log"))?;
        SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)
            .map_err(|_| RunnerError::Launch("SetHandleInformation stdio log"))?;
        Ok(handle)
    }
}

fn enable_launch_privileges(token: HANDLE) {
    unsafe {
        for name in [
            SE_INCREASE_QUOTA_NAME,
            SE_ASSIGNPRIMARYTOKEN_NAME,
            SE_IMPERSONATE_NAME,
        ] {
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
            let _ = AdjustTokenPrivileges(token, false, Some(ptr::from_ref(&state)), 0, None, None);
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

pub fn appcontainer_sid_string() -> Result<String, RunnerError> {
    let sid = ensure_appcontainer_profile()?;
    super::sid_to_string(sid)
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
