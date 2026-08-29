#![cfg(windows)]

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Pipes::WaitNamedPipeW;
use windows::core::PCWSTR;

fn main() {
    let mut args = env::args().skip(1);
    let cmd = args.next().expect("command");
    match cmd.as_str() {
        "read-file" => {
            let path = args.next().expect("path");
            match fs::read(&path) {
                Ok(bytes) => {
                    println!("READ {}", bytes.len());
                    std::process::exit(0);
                }
                Err(_) => {
                    println!("DENIED");
                    std::process::exit(2);
                }
            }
        }
        "extract-key" => {
            let path = args.next().expect("path");
            let needle = hex_decode(&args.next().expect("hex"));
            let wrapped = args.next().map(|h| hex_decode(&h));
            if let Some(blob) = wrapped.as_deref()
                && unprotect_without_entropy(blob).is_ok()
            {
                println!("UNPROTECTED");
                std::process::exit(0);
            }
            match fs::read(&path) {
                Ok(bytes) => {
                    if bytes.windows(needle.len()).any(|window| window == needle) {
                        println!("FOUND_PLAINTEXT");
                        std::process::exit(0);
                    }
                    println!("CIPHERTEXT_ONLY");
                    std::process::exit(2);
                }
                Err(_) => {
                    println!("DENIED");
                    std::process::exit(2);
                }
            }
        }
        "pipe-hello" => {
            let pipe = args.next().expect("pipe");
            let lie = args.next().as_deref() == Some("lie");
            speak_pipe(&pipe, lie);
        }
        "sleep" => {
            let ms: u64 = args.next().unwrap_or_else(|| "2000".to_string()).parse().expect("ms");
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
        other => panic!("unknown command {other}"),
    }
}

fn speak_pipe(name: &str, lie: bool) {
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let _ = WaitNamedPipeW(PCWSTR(wide.as_ptr()), 10_000);
        let handle = CreateFileW(
            PCWSTR(wide.as_ptr()),
            GENERIC_READ.0 | GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
        .expect("CreateFileW pipe");
        if handle == INVALID_HANDLE_VALUE {
            panic!("invalid pipe");
        }
        let mut file = std::fs::File::from(OwnedHandle::from_raw_handle(handle.0));
        let mut len = [0u8; 4];
        file.read_exact(&mut len).expect("hello length");
        let n = u32::from_be_bytes(len) as usize;
        let mut hello = vec![0u8; n];
        file.read_exact(&mut hello).expect("hello body");
        let value: serde_json::Value = serde_json::from_slice(&hello).expect("hello json");
        let connection_id = value["connectionId"].as_str().expect("connectionId").to_string();
        let pid = if lie {
            1u32
        } else {
            std::process::id()
        };
        let creation = if lie {
            "1970-01-01T00:00:00.000Z".to_string()
        } else {
            process_creation_time()
        };
        let body = serde_json::json!({
            "claimedProcessCreationTime": creation,
            "claimedProcessId": pid,
            "clientInstanceId": "probe_1",
            "clientNonce": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "connectionId": connection_id,
            "protocolVersion": 1
        });
        let bytes = serde_json_canonicalizer::to_vec(&body).expect("canonical hello");
        file.write_all(&(bytes.len() as u32).to_be_bytes()).expect("write len");
        file.write_all(&bytes).expect("write body");
        file.flush().ok();
    }
}

fn process_creation_time() -> String {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    unsafe {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
        .expect("GetProcessTimes");
        let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
        const EPOCH_DIFF_100NS: u64 = 116444736000000000;
        let unix_ms = ticks.saturating_sub(EPOCH_DIFF_100NS) / 10_000;
        unix_millis_to_rfc3339(unix_ms)
    }
}

fn unix_millis_to_rfc3339(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400) as u32;
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u32;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn unprotect_without_entropy(ciphertext: &[u8]) -> Result<Vec<u8>, ()> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| ())?;
        if output.pbData.is_null() || output.cbData == 0 {
            return Err(());
        }
        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut std::ffi::c_void)));
        Ok(plain)
    }
}
