use crate::config::sha256_digest_tagged;
use crate::windows::paths::{
    PathReject, final_path_contained, nfc, reject_component_name, to_extended_path, to_wide,
};
use std::path::Path;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, LocalFree};
use windows::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows::Win32::Security::{
    DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetSecurityDescriptorLength,
    LABEL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_BEGIN,
    FILE_CASE_SENSITIVE_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_FLAG_SEQUENTIAL_SCAN, FILE_FLAGS_AND_ATTRIBUTES, FILE_GENERIC_READ, FILE_ID_INFO,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO, FILE_STREAM_INFO, FileAttributeTagInfo,
    FileCaseSensitiveInfo, FileIdInfo, FileStandardInfo, FileStreamInfo, FindClose, FindFirstFileW,
    FindNextFileW, GetFileInformationByHandleEx, GetFinalPathNameByHandleW, OPEN_EXISTING,
    READ_CONTROL, ReadFile, SetFilePointerEx, VOLUME_NAME_DOS, WIN32_FIND_DATAW,
};
use windows::Win32::System::IO::DeviceIoControl;
use windows::Win32::System::Ioctl::FSCTL_GET_REPARSE_POINT;
use windows::core::PCWSTR;

pub const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;
pub const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
pub const IO_REPARSE_TAG_LX_SYMLINK: u32 = 0xA000_001D;
const FILE_CS_FLAG_CASE_SENSITIVE_DIR: u32 = 0x0000_0001;

#[derive(Debug)]
pub enum HandleError {
    Path(PathReject),
    Io(std::io::Error),
}

impl std::fmt::Display for HandleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Path(reject) => write!(f, "{}", reject.code()),
            Self::Io(error) => write!(f, "io: {error}"),
        }
    }
}

impl std::error::Error for HandleError {}

impl From<PathReject> for HandleError {
    fn from(value: PathReject) -> Self {
        Self::Path(value)
    }
}

fn io_from_windows(err: windows::core::Error) -> std::io::Error {
    std::io::Error::other(err.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FileIdentity {
    pub volume_serial: u64,
    pub file_id: [u8; 16],
}

impl FileIdentity {
    pub fn encoded(&self) -> String {
        let mut hex = String::with_capacity(16 + 1 + 32);
        hex.push_str(&format!("{:016x}:", self.volume_serial));
        for b in self.file_id {
            hex.push_str(&format!("{b:02x}"));
        }
        hex
    }
}

#[derive(Debug, Clone)]
pub struct StreamInfo {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct OpenedFile {
    pub identity: FileIdentity,
    pub final_path: String,
    pub attributes: u32,
    pub reparse_tag: Option<u32>,
    pub is_directory: bool,
    pub link_count: u32,
    pub size: u64,
    pub case_sensitive: bool,
    pub security_descriptor_digest: String,
    pub streams: Vec<StreamInfo>,
}

pub struct FileHandle {
    handle: HANDLE,
}

impl Drop for FileHandle {
    fn drop(&mut self) {
        unsafe {
            if !self.handle.is_invalid() && self.handle != INVALID_HANDLE_VALUE {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

impl FileHandle {
    pub fn raw(&self) -> HANDLE {
        self.handle
    }
}

fn open_with_share(
    path: &Path,
    share: windows::Win32::Storage::FileSystem::FILE_SHARE_MODE,
) -> Result<FileHandle, HandleError> {
    let extended = to_extended_path(path);
    let wide = to_wide(&extended.to_string_lossy());
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_GENERIC_READ.0 | READ_CONTROL.0,
            share,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(
                FILE_FLAG_BACKUP_SEMANTICS.0
                    | FILE_FLAG_OPEN_REPARSE_POINT.0
                    | FILE_FLAG_SEQUENTIAL_SCAN.0,
            ),
            None,
        )
    }
    .map_err(|err| HandleError::Io(io_from_windows(err)))?;
    if handle.is_invalid() {
        return Err(HandleError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "CreateFileW returned INVALID_HANDLE_VALUE",
        )));
    }
    Ok(FileHandle { handle })
}

pub fn open_reparse_handle(path: &Path) -> Result<FileHandle, HandleError> {
    open_with_share(path, FILE_SHARE_READ | FILE_SHARE_WRITE)
}

pub fn open_deny_write_handle(path: &Path) -> Result<FileHandle, HandleError> {
    open_with_share(path, FILE_SHARE_READ)
}

pub fn inspect_handle(handle: &FileHandle) -> Result<OpenedFile, HandleError> {
    let identity = file_identity(handle)?;
    let final_path = final_path_name(handle)?;
    let (attributes, reparse_tag) = attribute_tag(handle)?;
    let (is_directory, link_count, size) = standard_info(handle)?;
    let case_sensitive = query_case_sensitive(handle).unwrap_or(false);
    let security_descriptor_digest = security_digest(handle)?;
    let streams = enumerate_streams(handle)?;
    Ok(OpenedFile {
        identity,
        final_path,
        attributes,
        reparse_tag,
        is_directory,
        link_count,
        size,
        case_sensitive,
        security_descriptor_digest,
        streams,
    })
}

pub fn read_handle_bytes(handle: &FileHandle) -> Result<Vec<u8>, HandleError> {
    rewind_handle(handle)?;
    let mut out = Vec::new();
    let mut buf = vec![0u8; 1024 * 64];
    loop {
        let read = read_handle_chunk(handle, &mut buf)?;
        if read == 0 {
            break;
        }
        out.extend_from_slice(&buf[..read]);
    }
    Ok(out)
}

pub fn rewind_handle(handle: &FileHandle) -> Result<(), HandleError> {
    unsafe { SetFilePointerEx(handle.raw(), 0, None, FILE_BEGIN) }
        .map_err(|err| HandleError::Io(io_from_windows(err)))
}

pub fn read_handle_chunk(handle: &FileHandle, buf: &mut [u8]) -> Result<usize, HandleError> {
    let mut read = 0u32;
    unsafe { ReadFile(handle.raw(), Some(buf), Some(&mut read), None) }
        .map_err(|err| HandleError::Io(io_from_windows(err)))?;
    Ok(read as usize)
}

pub fn read_named_stream(parent: &Path, stream_name: &str) -> Result<Vec<u8>, HandleError> {
    let joined = format!(
        "{}:{stream_name}",
        to_extended_path(parent).to_string_lossy()
    );
    let handle = open_reparse_handle(Path::new(&joined))?;
    read_handle_bytes(&handle)
}

pub fn symlink_target(handle: &FileHandle) -> Result<String, HandleError> {
    let mut buf = vec![0u8; 16 * 1024];
    let mut returned = 0u32;
    unsafe {
        DeviceIoControl(
            handle.raw(),
            FSCTL_GET_REPARSE_POINT,
            None,
            0,
            Some(buf.as_mut_ptr().cast()),
            buf.len() as u32,
            Some(&mut returned),
            None,
        )
    }
    .map_err(|err| HandleError::Io(io_from_windows(err)))?;
    parse_reparse_target(&buf[..returned as usize]).map_err(HandleError::Path)
}

pub fn classify_reparse(tag: u32) -> Result<ReparseClass, PathReject> {
    match tag {
        IO_REPARSE_TAG_SYMLINK => Ok(ReparseClass::Symlink),
        IO_REPARSE_TAG_MOUNT_POINT | IO_REPARSE_TAG_LX_SYMLINK => Err(PathReject::DeviceNamespace),
        _ => Err(PathReject::DeviceNamespace),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReparseClass {
    Symlink,
}

pub fn enumerate_directory(path: &Path) -> Result<Vec<Dirent>, HandleError> {
    let pattern = to_extended_path(path).join("*");
    let wide = to_wide(&pattern.to_string_lossy());
    let mut data = WIN32_FIND_DATAW::default();
    let find = unsafe { FindFirstFileW(PCWSTR(wide.as_ptr()), &mut data) }
        .map_err(|err| HandleError::Io(io_from_windows(err)))?;
    let mut out = Vec::new();
    loop {
        let name = utf16_file_name(&data.cFileName);
        if name != "." && name != ".." {
            reject_component_name(&name).map_err(HandleError::Path)?;
            if !nfc(&name).eq(&name) {
                return Err(HandleError::Path(PathReject::TrailingDotOrSpace));
            }
            let alternate_name = utf16_file_name(&data.cAlternateFileName);
            out.push(Dirent {
                name,
                alternate_name,
                attributes: data.dwFileAttributes,
            });
        }
        let next = unsafe { FindNextFileW(find, &mut data) };
        if next.is_err() {
            break;
        }
    }
    unsafe {
        let _ = FindClose(find);
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct Dirent {
    pub name: String,
    pub alternate_name: String,
    pub attributes: u32,
}

pub fn is_reparse(attributes: u32) -> bool {
    attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
}

pub fn assert_contained(root: &OpenedFile, child: &OpenedFile) -> Result<(), PathReject> {
    if child.identity.volume_serial != root.identity.volume_serial {
        return Err(PathReject::RemoteVolume);
    }
    if !final_path_contained(&root.final_path, &child.final_path) {
        return Err(PathReject::Unc);
    }
    Ok(())
}

fn file_identity(handle: &FileHandle) -> Result<FileIdentity, HandleError> {
    let mut info = FILE_ID_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            handle.raw(),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .map_err(|err| HandleError::Io(io_from_windows(err)))?;
    Ok(FileIdentity {
        volume_serial: info.VolumeSerialNumber,
        file_id: info.FileId.Identifier,
    })
}

fn final_path_name(handle: &FileHandle) -> Result<String, HandleError> {
    let mut buf = vec![0u16; 32768];
    let n = unsafe { GetFinalPathNameByHandleW(handle.raw(), buf.as_mut_slice(), VOLUME_NAME_DOS) };
    if n == 0 || n as usize >= buf.len() {
        return Err(HandleError::Io(std::io::Error::other(
            "GetFinalPathNameByHandleW failed",
        )));
    }
    buf.truncate(n as usize);
    Ok(String::from_utf16_lossy(&buf))
}

fn attribute_tag(handle: &FileHandle) -> Result<(u32, Option<u32>), HandleError> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            handle.raw(),
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    }
    .map_err(|err| HandleError::Io(io_from_windows(err)))?;
    let tag = if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        Some(info.ReparseTag)
    } else {
        None
    };
    Ok((info.FileAttributes, tag))
}

fn standard_info(handle: &FileHandle) -> Result<(bool, u32, u64), HandleError> {
    let mut info = FILE_STANDARD_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            handle.raw(),
            FileStandardInfo,
            (&mut info as *mut FILE_STANDARD_INFO).cast(),
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    }
    .map_err(|err| HandleError::Io(io_from_windows(err)))?;
    Ok((info.Directory, info.NumberOfLinks, info.EndOfFile as u64))
}

fn query_case_sensitive(handle: &FileHandle) -> Result<bool, HandleError> {
    let mut info = FILE_CASE_SENSITIVE_INFO::default();
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle.raw(),
            FileCaseSensitiveInfo,
            (&mut info as *mut FILE_CASE_SENSITIVE_INFO).cast(),
            std::mem::size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
        )
    };
    if ok.is_err() {
        return Ok(false);
    }
    Ok(info.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR != 0)
}

fn security_digest(handle: &FileHandle) -> Result<String, HandleError> {
    let mut sd = PSECURITY_DESCRIPTOR::default();
    unsafe {
        let _ = GetSecurityInfo(
            handle.raw(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | GROUP_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | LABEL_SECURITY_INFORMATION,
            None,
            None,
            None,
            None,
            Some(&mut sd),
        );
    }
    if sd.0.is_null() {
        return Ok(sha256_digest_tagged(b""));
    }
    let len = unsafe { GetSecurityDescriptorLength(sd) };
    let bytes = unsafe { std::slice::from_raw_parts(sd.0 as *const u8, len as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(sd.0)));
    }
    Ok(sha256_digest_tagged(&bytes))
}

fn enumerate_streams(handle: &FileHandle) -> Result<Vec<StreamInfo>, HandleError> {
    let mut buf = vec![0u8; 64 * 1024];
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle.raw(),
            FileStreamInfo,
            buf.as_mut_ptr().cast(),
            buf.len() as u32,
        )
    };
    if ok.is_err() {
        return Ok(Vec::new());
    }
    let mut streams = Vec::new();
    let mut offset = 0usize;
    loop {
        if offset + std::mem::size_of::<FILE_STREAM_INFO>() > buf.len() {
            break;
        }
        let info = unsafe { &*(buf.as_ptr().add(offset).cast::<FILE_STREAM_INFO>()) };
        let name_bytes = info.StreamNameLength as usize / 2;
        let name_ptr = info.StreamName.as_ptr();
        let slice = unsafe { std::slice::from_raw_parts(name_ptr, name_bytes) };
        let raw = String::from_utf16_lossy(slice);
        let name = raw
            .trim_end_matches(":$DATA")
            .trim_start_matches(':')
            .to_string();
        if !name.is_empty() {
            streams.push(StreamInfo {
                name,
                size: info.StreamSize as u64,
            });
        }
        if info.NextEntryOffset == 0 {
            break;
        }
        offset += info.NextEntryOffset as usize;
    }
    Ok(streams)
}

fn parse_reparse_target(buf: &[u8]) -> Result<String, PathReject> {
    if buf.len() < 20 {
        return Err(PathReject::DeviceNamespace);
    }
    let tag = u32::from_le_bytes(buf[0..4].try_into().unwrap_or([0; 4]));
    classify_reparse(tag)?;
    let mut cursor = 8usize;
    if tag == IO_REPARSE_TAG_SYMLINK {
        cursor = 8;
    }
    if buf.len() < cursor + 12 {
        return Err(PathReject::DeviceNamespace);
    }
    let subst_off =
        u16::from_le_bytes(buf[cursor..cursor + 2].try_into().unwrap_or([0; 2])) as usize;
    let subst_len =
        u16::from_le_bytes(buf[cursor + 2..cursor + 4].try_into().unwrap_or([0; 2])) as usize;
    let path_buf_start = if tag == IO_REPARSE_TAG_SYMLINK {
        cursor + 12
    } else {
        cursor + 8
    };
    let start = path_buf_start + subst_off;
    let end = start + subst_len;
    if end > buf.len() {
        return Err(PathReject::DeviceNamespace);
    }
    let units: Vec<u16> = buf[start..end]
        .chunks(2)
        .map(|c| u16::from_le_bytes([c[0], c.get(1).copied().unwrap_or(0)]))
        .collect();
    let mut target = String::from_utf16_lossy(&units);
    if let Some(stripped) = target.strip_prefix(r"\??\") {
        target = stripped.to_string();
    }
    Ok(target)
}

fn utf16_file_name(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

pub fn volume_identity_string(id: &FileIdentity) -> String {
    format!("vol:{:016x}", id.volume_serial)
}

#[cfg(test)]
mod tests {
    use super::{IO_REPARSE_TAG_LX_SYMLINK, IO_REPARSE_TAG_SYMLINK, classify_reparse};

    #[test]
    fn lx_symlink_is_unknown_reparse() {
        assert!(classify_reparse(IO_REPARSE_TAG_LX_SYMLINK).is_err());
        assert!(classify_reparse(IO_REPARSE_TAG_SYMLINK).is_ok());
        assert!(classify_reparse(0x1234_5678).is_err());
    }
}
