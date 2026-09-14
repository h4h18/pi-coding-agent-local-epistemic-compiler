#![allow(clippy::manual_ignore_case_cmp)]
#![allow(clippy::collapsible_if)]

use std::path::{Path, PathBuf};
use windows::Win32::Storage::FileSystem::{
    GetDriveTypeW, GetFullPathNameW, GetLongPathNameW, GetShortPathNameW, GetVolumePathNameW,
};
use windows::core::PCWSTR;

const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_FIXED: u32 = 3;
const DRIVE_RAMDISK: u32 = 6;

const RESERVED_BASE: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    "CONIN$", "CONOUT$",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathReject {
    Unc,
    WebDav,
    DeviceNamespace,
    DriveRelative,
    ReservedName,
    TrailingDotOrSpace,
    NotAbsolute,
    RemoteVolume,
    EightDotThreeAlias,
}

impl PathReject {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unc => "UNC",
            Self::WebDav => "WEBDAV",
            Self::DeviceNamespace => "DEVICE_NAMESPACE",
            Self::DriveRelative => "DRIVE_RELATIVE",
            Self::ReservedName => "RESERVED_NAME",
            Self::TrailingDotOrSpace => "TRAILING_DOT_OR_SPACE",
            Self::NotAbsolute => "NOT_ABSOLUTE",
            Self::RemoteVolume => "REMOTE_VOLUME",
            Self::EightDotThreeAlias => "EIGHT_DOT_THREE",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LocalRoot {
    pub display: PathBuf,
    pub extended: PathBuf,
}

pub fn classify_snapshot_root(input: &str) -> Result<LocalRoot, PathReject> {
    if input.is_empty() {
        return Err(PathReject::NotAbsolute);
    }
    reject_unc_device_drive_relative(input)?;
    let wide = to_wide(input);
    let mut full = vec![0u16; 32768];
    let written =
        unsafe { GetFullPathNameW(PCWSTR(wide.as_ptr()), Some(full.as_mut_slice()), None) };
    if written == 0 || (written as usize) >= full.len() {
        return Err(PathReject::NotAbsolute);
    }
    full.truncate(written as usize);
    let expanded = from_wide(&full);
    reject_unc_device_drive_relative(&expanded)?;
    reject_reserved_and_trailing(&expanded)?;
    if looks_like_8_3_component(&expanded) {
        return Err(PathReject::EightDotThreeAlias);
    }
    if is_webdav_or_remote(&expanded) {
        return Err(PathReject::WebDav);
    }
    let display = PathBuf::from(&expanded);
    if !display.is_absolute() {
        return Err(PathReject::NotAbsolute);
    }
    Ok(LocalRoot {
        extended: to_extended_path(&display),
        display,
    })
}

pub fn reject_unc_device_drive_relative(input: &str) -> Result<(), PathReject> {
    let n = input.replace('/', "\\");
    let upper = n.to_ascii_uppercase();
    if upper.starts_with("\\\\?\\UNC\\") || upper.starts_with("\\\\.\\UNC\\") {
        return Err(PathReject::Unc);
    }
    if upper.starts_with("\\\\?\\GLOBALROOT") || upper.starts_with("\\??\\") {
        return Err(PathReject::DeviceNamespace);
    }
    if upper.starts_with("\\\\.\\") {
        return Err(PathReject::DeviceNamespace);
    }
    if upper.starts_with("\\\\?\\VOLUME{") {
        return Err(PathReject::DeviceNamespace);
    }
    if n.starts_with("\\\\") && !upper.starts_with("\\\\?\\") {
        return Err(PathReject::Unc);
    }
    if n.starts_with("//") {
        return Err(PathReject::Unc);
    }
    if is_drive_relative(&n) {
        return Err(PathReject::DriveRelative);
    }
    if n.starts_with('\\') && !n.starts_with("\\\\") {
        return Err(PathReject::NotAbsolute);
    }
    if n.len() >= 2 && n.as_bytes()[1] == b':' {
        let rest = &n[2..];
        if rest.is_empty() || !(rest.starts_with('\\') || rest.starts_with('/')) {
            return Err(PathReject::DriveRelative);
        }
    } else if !upper.starts_with("\\\\?\\") {
        return Err(PathReject::NotAbsolute);
    }
    if upper.contains("DAVWVWROOT") || upper.contains("DAVWWWROOT") {
        return Err(PathReject::WebDav);
    }
    Ok(())
}

pub fn reject_component_name(name: &str) -> Result<(), PathReject> {
    if name.ends_with(' ') || name.ends_with('.') {
        return Err(PathReject::TrailingDotOrSpace);
    }
    if is_reserved_component(name) {
        return Err(PathReject::ReservedName);
    }
    if is_8_3_alias_name(name) {
        return Err(PathReject::EightDotThreeAlias);
    }
    Ok(())
}

pub fn reject_reserved_and_trailing(path: &str) -> Result<(), PathReject> {
    let n = path.replace('/', "\\");
    let stripped = n
        .strip_prefix("\\\\?\\")
        .or_else(|| n.strip_prefix("\\\\.\\"))
        .unwrap_or(&n);
    for component in stripped.split('\\').filter(|c| !c.is_empty()) {
        if component.len() == 2 && component.as_bytes()[1] == b':' {
            continue;
        }
        reject_component_name(component)?;
    }
    Ok(())
}

pub fn is_nfc(text: &str) -> bool {
    nfc(text) == text
}

pub fn nfc(text: &str) -> String {
    normalize_string(text, windows::Win32::Globalization::NormalizationC)
}

pub fn nfd(text: &str) -> String {
    normalize_string(text, windows::Win32::Globalization::NormalizationD)
}

pub fn case_fold_key(text: &str, case_sensitive: bool) -> String {
    let n = nfc(text);
    if case_sensitive { n } else { n.to_uppercase() }
}

pub fn collision_key(name: &str, case_sensitive: bool) -> (String, String) {
    (case_fold_key(name, case_sensitive), nfc(name))
}

pub fn names_collide(left: &str, right: &str, case_sensitive: bool) -> bool {
    if left == right {
        return false;
    }
    let (a, a_nfc) = collision_key(left, case_sensitive);
    let (b, b_nfc) = collision_key(right, case_sensitive);
    a == b || a_nfc == b_nfc
}

pub fn to_extended_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if text.starts_with("\\\\?\\") {
        return path.to_path_buf();
    }
    PathBuf::from(format!("\\\\?\\{}", text.trim_start_matches("\\\\?\\")))
}

pub fn strip_extended_prefix(text: &str) -> &str {
    text.strip_prefix("\\\\?\\").unwrap_or(text)
}

pub fn final_path_contained(root_final: &str, candidate_final: &str) -> bool {
    let root = normalize_compare_path(root_final);
    let cand = normalize_compare_path(candidate_final);
    if cand.len() < root.len() {
        return false;
    }
    let root_u = root.to_ascii_uppercase();
    let cand_u = cand.to_ascii_uppercase();
    if cand_u == root_u {
        return true;
    }
    cand_u.starts_with(&root_u) && cand.as_bytes().get(root.len()) == Some(&b'\\')
}

pub fn long_path_for(path: &Path) -> Result<PathBuf, PathReject> {
    let wide = to_wide(&path.to_string_lossy());
    let mut buf = vec![0u16; 32768];
    let n = unsafe { GetLongPathNameW(PCWSTR(wide.as_ptr()), Some(buf.as_mut_slice())) };
    if n == 0 || (n as usize) >= buf.len() {
        return Ok(path.to_path_buf());
    }
    buf.truncate(n as usize);
    Ok(PathBuf::from(from_wide(&buf)))
}

pub fn reject_if_8_3_opened(requested: &Path, long_name: &Path) -> Result<(), PathReject> {
    let req = requested.to_string_lossy().replace('/', "\\");
    let long = long_name.to_string_lossy().replace('/', "\\");
    let req_cmp = normalize_compare_path(&req);
    let long_cmp = normalize_compare_path(&long);
    if req_cmp.to_ascii_uppercase() == long_cmp.to_ascii_uppercase() {
        return Ok(());
    }
    if looks_like_8_3_component(&req) {
        return Err(PathReject::EightDotThreeAlias);
    }
    Ok(())
}

pub fn reject_if_component_opened_as_8_3(
    opened_name: &str,
    long_name: &str,
    alternate_name: &str,
) -> Result<(), PathReject> {
    if alternate_name.is_empty() {
        return Ok(());
    }
    if opened_name.eq_ignore_ascii_case(alternate_name)
        && !opened_name.eq_ignore_ascii_case(long_name)
    {
        return Err(PathReject::EightDotThreeAlias);
    }
    Ok(())
}

pub fn short_path_for(path: &Path) -> Result<PathBuf, PathReject> {
    let wide = to_wide(&path.to_string_lossy());
    let mut buf = vec![0u16; 32768];
    let n = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), Some(buf.as_mut_slice())) };
    if n == 0 || (n as usize) >= buf.len() {
        return Ok(path.to_path_buf());
    }
    buf.truncate(n as usize);
    Ok(PathBuf::from(from_wide(&buf)))
}

fn is_drive_relative(n: &str) -> bool {
    let b = n.as_bytes();
    b.len() >= 2
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b.len() == 2 || (b[2] != b'\\' && b[2] != b'/'))
}

fn is_reserved_component(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    let upper = stem.to_ascii_uppercase();
    RESERVED_BASE.iter().any(|r| *r == upper)
}

fn is_8_3_alias_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    let (stem, ext) = match upper.split_once('.') {
        Some((s, e)) => (s, Some(e)),
        None => (upper.as_str(), None),
    };
    if !stem.contains('~') {
        return false;
    }
    let Some((left, right)) = stem.split_once('~') else {
        return false;
    };
    if left.is_empty() || left.len() > 6 {
        return false;
    }
    if right.is_empty() || !right.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if let Some(ext) = ext {
        if ext.len() > 3 {
            return false;
        }
    }
    true
}

fn looks_like_8_3_component(path: &str) -> bool {
    path.replace('/', "\\")
        .split('\\')
        .any(|c| !c.is_empty() && is_8_3_alias_name(c))
}

fn is_webdav_or_remote(path: &str) -> bool {
    let wide = to_wide(path);
    let mut volume = vec![0u16; 1024];
    let ok = unsafe { GetVolumePathNameW(PCWSTR(wide.as_ptr()), volume.as_mut_slice()) };
    if ok.is_err() {
        return true;
    }
    let drive = unsafe { GetDriveTypeW(PCWSTR(volume.as_ptr())) };
    if drive == DRIVE_FIXED || drive == DRIVE_REMOVABLE || drive == DRIVE_RAMDISK {
        return false;
    }
    true
}

fn normalize_compare_path(text: &str) -> String {
    let mut t = text.replace('/', "\\");
    if let Some(stripped) = t.strip_prefix("\\\\?\\") {
        t = stripped.to_string();
    }
    while t.ends_with('\\') && t.len() > 3 {
        t.pop();
    }
    t
}

fn normalize_string(text: &str, form: windows::Win32::Globalization::NORM_FORM) -> String {
    use windows::Win32::Globalization::NormalizeString;
    let src: Vec<u16> = text.encode_utf16().collect();
    if src.is_empty() {
        return String::new();
    }
    let needed = unsafe { NormalizeString(form, &src, None) };
    if needed <= 0 {
        return text.to_string();
    }
    let mut dst = vec![0u16; needed as usize];
    let written = unsafe { NormalizeString(form, &src, Some(dst.as_mut_slice())) };
    if written <= 0 {
        return text.to_string();
    }
    dst.truncate(written as usize);
    String::from_utf16_lossy(&dst)
}

pub fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

#[cfg(test)]
mod tests {
    use super::{
        PathReject, classify_snapshot_root, names_collide, reject_component_name,
        reject_if_component_opened_as_8_3, reject_unc_device_drive_relative,
    };

    #[test]
    fn rejects_unc_device_and_drive_relative() {
        assert_eq!(
            reject_unc_device_drive_relative(r"\\server\share\repo").unwrap_err(),
            PathReject::Unc
        );
        assert_eq!(
            reject_unc_device_drive_relative(r"\\?\UNC\server\share\repo").unwrap_err(),
            PathReject::Unc
        );
        assert_eq!(
            reject_unc_device_drive_relative(r"\\.\C:\Windows").unwrap_err(),
            PathReject::DeviceNamespace
        );
        assert_eq!(
            reject_unc_device_drive_relative(r"\??\C:\Windows").unwrap_err(),
            PathReject::DeviceNamespace
        );
        assert_eq!(
            reject_unc_device_drive_relative(r"C:relative").unwrap_err(),
            PathReject::DriveRelative
        );
        assert_eq!(
            reject_unc_device_drive_relative("//nas/share").unwrap_err(),
            PathReject::Unc
        );
    }

    #[test]
    fn rejects_reserved_and_trailing() {
        assert_eq!(
            reject_component_name("CON").unwrap_err(),
            PathReject::ReservedName
        );
        assert_eq!(
            reject_component_name("nul.txt").unwrap_err(),
            PathReject::ReservedName
        );
        assert_eq!(
            reject_component_name("file.txt ").unwrap_err(),
            PathReject::TrailingDotOrSpace
        );
        assert_eq!(
            reject_component_name("file.txt.").unwrap_err(),
            PathReject::TrailingDotOrSpace
        );
        assert_eq!(
            reject_component_name("PROGRA~1").unwrap_err(),
            PathReject::EightDotThreeAlias
        );
        reject_component_name("src").unwrap();
    }

    #[test]
    fn opened_short_name_component_is_rejected() {
        assert_eq!(
            reject_if_component_opened_as_8_3("PROGRA~1", "Program Files", "PROGRA~1").unwrap_err(),
            PathReject::EightDotThreeAlias
        );
        reject_if_component_opened_as_8_3("Program Files", "Program Files", "PROGRA~1").unwrap();
        reject_if_component_opened_as_8_3("src", "src", "").unwrap();
    }

    #[test]
    fn nfc_and_case_collisions() {
        assert!(names_collide("File.ts", "file.ts", false));
        assert!(!names_collide("File.ts", "file.ts", true));
        let nfd = "e\u{0301}";
        let nfc = "é";
        assert!(names_collide(nfd, nfc, true));
    }

    #[test]
    fn classify_rejects_unc_before_open() {
        assert!(matches!(
            classify_snapshot_root(r"\\localhost\c$\Windows"),
            Err(PathReject::Unc)
        ));
    }
}
