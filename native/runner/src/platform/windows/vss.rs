use crate::windows::paths::{to_wide, PathReject};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use windows::core::{GUID, HRESULT, Interface, PCWSTR};
use windows::Win32::Foundation::{E_ACCESSDENIED, E_NOINTERFACE, E_POINTER, E_UNEXPECTED, S_OK};
use windows::Win32::Storage::FileSystem::GetVolumePathNameW;
use windows::Win32::Storage::Vss::{IVssAsync, VSS_BT_FULL, VSS_CTX_BACKUP, VSS_SNAPSHOT_PROP};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

mod ffi {
    #![allow(non_snake_case)]
    use std::ffi::c_void;
    use windows_core::{interface, IUnknown, IUnknown_Vtbl, GUID, HRESULT, PCWSTR};
    use windows::Win32::Storage::Vss::{VSS_BACKUP_TYPE, VSS_SNAPSHOT_PROP};

    #[interface("665c1d5f-c218-414d-a05d-7fef5f9d5c86")]
    pub(super) unsafe trait IVssBackupComponents: IUnknown {
        unsafe fn _slot01(&self) -> HRESULT;
        unsafe fn _slot02(&self) -> HRESULT;
        pub(super) unsafe fn InitializeForBackup(&self, bstrxml: PCWSTR) -> HRESULT;
        pub(super) unsafe fn SetBackupState(
            &self,
            bselectcomponents: bool,
            bbackupbootablesystemstate: bool,
            backuptype: VSS_BACKUP_TYPE,
            bpartialfilesupport: bool,
        ) -> HRESULT;
        unsafe fn _slot05(&self) -> HRESULT;
        unsafe fn _slot06(&self) -> HRESULT;
        pub(super) unsafe fn GatherWriterMetadata(&self, ppasync: *mut *mut c_void) -> HRESULT;
        unsafe fn _slot08(&self) -> HRESULT;
        unsafe fn _slot09(&self) -> HRESULT;
        unsafe fn _slot10(&self) -> HRESULT;
        unsafe fn _slot11(&self) -> HRESULT;
        pub(super) unsafe fn PrepareForBackup(&self, ppasync: *mut *mut c_void) -> HRESULT;
        unsafe fn _slot13(&self) -> HRESULT;
        unsafe fn _slot14(&self) -> HRESULT;
        unsafe fn _slot15(&self) -> HRESULT;
        unsafe fn _slot16(&self) -> HRESULT;
        unsafe fn _slot17(&self) -> HRESULT;
        unsafe fn _slot18(&self) -> HRESULT;
        unsafe fn _slot19(&self) -> HRESULT;
        unsafe fn _slot20(&self) -> HRESULT;
        unsafe fn _slot21(&self) -> HRESULT;
        unsafe fn _slot22(&self) -> HRESULT;
        unsafe fn _slot23(&self) -> HRESULT;
        unsafe fn _slot24(&self) -> HRESULT;
        pub(super) unsafe fn BackupComplete(&self, ppasync: *mut *mut c_void) -> HRESULT;
        unsafe fn _slot26(&self) -> HRESULT;
        unsafe fn _slot27(&self) -> HRESULT;
        unsafe fn _slot28(&self) -> HRESULT;
        unsafe fn _slot29(&self) -> HRESULT;
        unsafe fn _slot30(&self) -> HRESULT;
        unsafe fn _slot31(&self) -> HRESULT;
        unsafe fn _slot32(&self) -> HRESULT;
        pub(super) unsafe fn SetContext(&self, lcontext: i32) -> HRESULT;
        pub(super) unsafe fn StartSnapshotSet(&self, psnapshotsetid: *mut GUID) -> HRESULT;
        pub(super) unsafe fn AddToSnapshotSet(
            &self,
            pwszvolumename: PCWSTR,
            providerid: GUID,
            pidsnapshot: *mut GUID,
        ) -> HRESULT;
        pub(super) unsafe fn DoSnapshotSet(&self, ppasync: *mut *mut c_void) -> HRESULT;
        pub(super) unsafe fn DeleteSnapshots(
            &self,
            sourceobjectid: GUID,
            esourceobjecttype: i32,
            bforcedelete: bool,
            pldeletedsnapshots: *mut i32,
            pnondeletedsnapshotid: *mut GUID,
        ) -> HRESULT;
        unsafe fn _slot38(&self) -> HRESULT;
        unsafe fn _slot39(&self) -> HRESULT;
        pub(super) unsafe fn GetSnapshotProperties(
            &self,
            snapshotid: GUID,
            pprop: *mut VSS_SNAPSHOT_PROP,
        ) -> HRESULT;
        unsafe fn _slot41(&self) -> HRESULT;
        unsafe fn _slot42(&self) -> HRESULT;
        unsafe fn _slot43(&self) -> HRESULT;
        unsafe fn _slot44(&self) -> HRESULT;
        unsafe fn _slot45(&self) -> HRESULT;
        unsafe fn _slot46(&self) -> HRESULT;
        unsafe fn _slot47(&self) -> HRESULT;
        unsafe fn _slot48(&self) -> HRESULT;
    }
}

use ffi::IVssBackupComponents;

type CreateFn = unsafe extern "system" fn(*mut *mut c_void) -> HRESULT;

pub struct VssShadow {
    device_object: PathBuf,
    volume_root: PathBuf,
    components: IVssBackupComponents,
    snapshot_id: GUID,
    com_owned: bool,
}

impl VssShadow {
    pub fn map_path(&self, original_root: &Path) -> PathBuf {
        let orig = original_root.to_string_lossy();
        let vol = self.volume_root.to_string_lossy();
        let suffix = orig
            .strip_prefix(vol.as_ref())
            .or_else(|| orig.strip_prefix(vol.trim_end_matches('\\')))
            .unwrap_or("");
        let suffix = suffix.trim_start_matches('\\');
        if suffix.is_empty() {
            self.device_object.clone()
        } else {
            self.device_object.join(suffix)
        }
    }
}

impl Drop for VssShadow {
    fn drop(&mut self) {
        unsafe {
            let mut async_ptr: *mut c_void = std::ptr::null_mut();
            let _ = self.components.BackupComplete(&mut async_ptr);
            if !async_ptr.is_null() {
                wait_async(async_ptr);
            }
            let mut deleted = 0i32;
            let mut leftover = GUID::zeroed();
            let _ = self.components.DeleteSnapshots(
                self.snapshot_id,
                3,
                true,
                &mut deleted,
                &mut leftover,
            );
            if self.com_owned {
                CoUninitialize();
            }
        }
    }
}

#[derive(Debug)]
pub enum VssError {
    Unexpected(&'static str),
}

enum VssCreateError {
    Unavailable,
    Unexpected(&'static str),
}

pub fn try_create_vss(root: &Path) -> Result<Option<VssShadow>, VssError> {
    match create_vss(root) {
        Ok(shadow) => Ok(Some(shadow)),
        Err(VssCreateError::Unavailable) => Ok(None),
        Err(VssCreateError::Unexpected(msg)) => Err(VssError::Unexpected(msg)),
    }
}

fn is_abi_failure(hr: HRESULT) -> bool {
    hr == E_NOINTERFACE || hr == E_POINTER || hr == E_UNEXPECTED
}

fn map_hr(hr: HRESULT, unexpected_msg: &'static str) -> VssCreateError {
    if is_abi_failure(hr) {
        VssCreateError::Unexpected(unexpected_msg)
    } else {
        VssCreateError::Unavailable
    }
}

fn create_vss(root: &Path) -> Result<VssShadow, VssCreateError> {
    let volume = volume_root(root).map_err(|_| VssCreateError::Unavailable)?;
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        let rpc_e_changed_mode = HRESULT(0x8001_0106u32 as i32);
        let com_owned = hr == S_OK;
        if hr.is_err() && hr.0 != 1 && hr != rpc_e_changed_mode {
            if is_abi_failure(hr) {
                return Err(VssCreateError::Unexpected("vss CoInitializeEx ABI failure"));
            }
            return Err(VssCreateError::Unavailable);
        }
        let components = match create_backup_components() {
            Ok(c) => c,
            Err(err) => {
                if com_owned {
                    CoUninitialize();
                }
                return Err(err);
            }
        };
        let init = components.InitializeForBackup(PCWSTR::null());
        if init.is_err() {
            if com_owned {
                CoUninitialize();
            }
            return Err(map_hr(init, "vss InitializeForBackup ABI failure"));
        }
        let ctx = components.SetContext(VSS_CTX_BACKUP.0);
        if ctx.is_err() {
            if com_owned {
                CoUninitialize();
            }
            return Err(map_hr(ctx, "vss SetContext ABI failure"));
        }
        let _ = components.SetBackupState(false, false, VSS_BT_FULL, false);
        let mut async_ptr: *mut c_void = std::ptr::null_mut();
        if components.GatherWriterMetadata(&mut async_ptr).is_ok() && !async_ptr.is_null() {
            wait_async(async_ptr);
        }
        let mut set_id = GUID::zeroed();
        let start = components.StartSnapshotSet(&mut set_id);
        if start.is_err() {
            if com_owned {
                CoUninitialize();
            }
            return Err(map_hr(start, "vss StartSnapshotSet ABI failure"));
        }
        let vol_wide = to_wide(&volume.to_string_lossy());
        let mut snap_id = GUID::zeroed();
        let added = components.AddToSnapshotSet(PCWSTR(vol_wide.as_ptr()), GUID::zeroed(), &mut snap_id);
        if added.is_err() {
            if com_owned {
                CoUninitialize();
            }
            return Err(map_hr(added, "vss AddToSnapshotSet ABI failure"));
        }
        async_ptr = std::ptr::null_mut();
        if components.PrepareForBackup(&mut async_ptr).is_ok() && !async_ptr.is_null() {
            wait_async(async_ptr);
        }
        async_ptr = std::ptr::null_mut();
        let snap = components.DoSnapshotSet(&mut async_ptr);
        if snap.is_err() {
            if com_owned {
                CoUninitialize();
            }
            return Err(map_hr(snap, "vss DoSnapshotSet ABI failure"));
        }
        if !async_ptr.is_null() {
            wait_async(async_ptr);
        }
        let mut prop = VSS_SNAPSHOT_PROP::default();
        let props = components.GetSnapshotProperties(snap_id, &mut prop);
        if props.is_err() {
            if com_owned {
                CoUninitialize();
            }
            return Err(map_hr(props, "vss GetSnapshotProperties ABI failure"));
        }
        let device = wide_ptr_to_string(prop.m_pwszSnapshotDeviceObject);
        if device.is_empty() {
            if com_owned {
                CoUninitialize();
            }
            return Err(VssCreateError::Unexpected("vss snapshot device object missing"));
        }
        Ok(VssShadow {
            device_object: PathBuf::from(device),
            volume_root: volume,
            components,
            snapshot_id: snap_id,
            com_owned,
        })
    }
}

fn create_backup_components() -> Result<IVssBackupComponents, VssCreateError> {
    unsafe {
        let dll = LoadLibraryW(windows::core::w!("vssapi.dll")).map_err(|_| VssCreateError::Unavailable)?;
        let proc = GetProcAddress(dll, windows::core::s!("CreateVssBackupComponentsInternal"))
            .ok_or(VssCreateError::Unexpected("vss CreateVssBackupComponentsInternal missing"))?;
        let create: CreateFn = std::mem::transmute(proc);
        let mut raw: *mut c_void = std::ptr::null_mut();
        let hr = create(&mut raw);
        if hr == E_ACCESSDENIED {
            return Err(VssCreateError::Unavailable);
        }
        if is_abi_failure(hr) {
            return Err(VssCreateError::Unexpected("vss create ABI failure"));
        }
        if hr != S_OK {
            return Err(VssCreateError::Unavailable);
        }
        if raw.is_null() {
            return Err(VssCreateError::Unexpected("vss create returned null"));
        }
        Ok(IVssBackupComponents::from_raw(raw))
    }
}

fn wait_async(ptr: *mut c_void) {
    unsafe {
        let async_obj = IVssAsync::from_raw(ptr);
        let _ = async_obj.Wait(10_000);
    }
}

fn wide_ptr_to_string(ptr: *mut u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    unsafe {
        while *ptr.add(len) != 0 {
            len += 1;
            if len > 32_768 {
                break;
            }
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
}

fn volume_root(path: &Path) -> Result<PathBuf, PathReject> {
    let wide = to_wide(&path.to_string_lossy());
    let mut buf = vec![0u16; 1024];
    unsafe { GetVolumePathNameW(PCWSTR(wide.as_ptr()), buf.as_mut_slice()) }
        .map_err(|_| PathReject::RemoteVolume)?;
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    Ok(PathBuf::from(String::from_utf16_lossy(&buf[..end])))
}
