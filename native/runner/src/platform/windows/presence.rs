use crate::config::RunnerError;
use std::ffi::c_void;
use windows::core::{BOOL, GUID, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::Networking::WindowsWebServices::{
    WebAuthNAuthenticatorGetAssertion, WebAuthNFreeAssertion, WEBAUTHN_ASSERTION,
    WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS, WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_CURRENT_VERSION,
    WEBAUTHN_CLIENT_DATA, WEBAUTHN_CLIENT_DATA_CURRENT_VERSION, WEBAUTHN_CREDENTIALS, WEBAUTHN_EXTENSIONS,
    WEBAUTHN_HASH_ALGORITHM_SHA_256,
};

const PRODUCTION_PRESENCE_TIMEOUT_MS: u32 = 120_000;

#[derive(Debug)]
pub enum PresenceError {
    Absent,
    Mismatch,
}

impl std::fmt::Display for PresenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Absent => f.write_str("authenticator-absent"),
            Self::Mismatch => f.write_str("presence-mismatch"),
        }
    }
}

impl std::error::Error for PresenceError {}

impl From<PresenceError> for RunnerError {
    fn from(value: PresenceError) -> Self {
        RunnerError::Identity(match value {
            PresenceError::Absent => "authenticator-absent",
            PresenceError::Mismatch => "presence-mismatch",
        })
    }
}

pub fn request_platform_assertion(challenge_digest: &str) -> Result<(), PresenceError> {
    request_platform_assertion_timed(challenge_digest, PRODUCTION_PRESENCE_TIMEOUT_MS)
}

pub fn request_platform_assertion_timed(
    challenge_digest: &str,
    timeout_ms: u32,
) -> Result<(), PresenceError> {
    if challenge_digest.is_empty() || !challenge_digest.starts_with("sha256:") {
        return Err(PresenceError::Mismatch);
    }
    let client_json = format!(
        r#"{{"type":"webauthn.get","challenge":"{challenge_digest}","origin":"pi-hec-runner"}}"#
    );
    let mut client_bytes = client_json.into_bytes();
    let rp: Vec<u16> = "pi-hec.local\0".encode_utf16().collect();
    let mut app_id_used = BOOL(0);
    let options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
        dwVersion: WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_CURRENT_VERSION,
        dwTimeoutMilliseconds: timeout_ms,
        CredentialList: WEBAUTHN_CREDENTIALS::default(),
        Extensions: WEBAUTHN_EXTENSIONS::default(),
        dwAuthenticatorAttachment: 0,
        dwUserVerificationRequirement: 0,
        dwFlags: 0,
        pwszU2fAppId: PCWSTR::null(),
        pbU2fAppId: std::ptr::from_mut(&mut app_id_used),
        pCancellationId: std::ptr::null_mut::<GUID>(),
        pAllowCredentialList: std::ptr::null_mut(),
        dwCredLargeBlobOperation: 0,
        cbCredLargeBlob: 0,
        pbCredLargeBlob: std::ptr::null_mut(),
        pHmacSecretSaltValues: std::ptr::null_mut(),
        bBrowserInPrivateMode: BOOL(0),
        pLinkedDevice: std::ptr::null_mut(),
        bAutoFill: BOOL(0),
        cbJsonExt: 0,
        pbJsonExt: std::ptr::null_mut(),
    };
    let client = WEBAUTHN_CLIENT_DATA {
        dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
        cbClientDataJSON: client_bytes.len() as u32,
        pbClientDataJSON: client_bytes.as_mut_ptr(),
        pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
    };
    let assertion = unsafe {
        WebAuthNAuthenticatorGetAssertion(
            HWND(std::ptr::null_mut::<c_void>()),
            PCWSTR(rp.as_ptr()),
            &client,
            Some(&options),
        )
    };
    match assertion {
        Ok(ptr) => {
            if ptr.is_null() {
                return Err(PresenceError::Absent);
            }
            let valid = unsafe {
                let assertion: &WEBAUTHN_ASSERTION = &*ptr;
                assertion.cbSignature > 0 && assertion.cbAuthenticatorData > 0
            };
            unsafe { WebAuthNFreeAssertion(ptr) };
            if valid {
                Ok(())
            } else {
                Err(PresenceError::Mismatch)
            }
        }
        Err(_) => Err(PresenceError::Absent),
    }
}

#[cfg(test)]
mod tests {
    use super::request_platform_assertion_timed;

    #[test]
    fn platform_webauthn_fail_closes_without_hello() {
        let result = request_platform_assertion_timed(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            1,
        );
        assert!(result.is_err(), "missing Hello must not count as presence");
    }
}
