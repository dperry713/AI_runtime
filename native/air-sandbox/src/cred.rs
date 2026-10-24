/**
 * Windows Credential Manager for air-sandbox.exe.
 *
 * Provides Credential Manager (CredWriteW/CredReadW/CredDeleteW) operations
 * for storing and retrieving secrets bound to the current Windows user logon.
 * Used by the AIR secrets module to protect the vault master key without
 * storing it in plaintext on disk.
 *
 * Requires the `Win32_Security_Credentials` feature of the `windows` crate.
 */

use windows::core::{PCWSTR, PWSTR, Result};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_ENTERPRISE,
    CRED_PERSIST_LOCAL_MACHINE, CRED_PERSIST_SESSION, CRED_TYPE_GENERIC,
};
use crate::protocol::{
    CredentialDeleteRequest, CredentialListEntry, CredentialListRequest, CredentialReadRequest,
    CredentialSpec, CredentialWriteRequest,
};

const AIR_CREDENTIAL_TARGET_PREFIX: &str = "AIR:";

/// Build a full target name from the AIR prefix and a suffix.
fn target_name(suffix: &str) -> String {
    format!("{}{}", AIR_CREDENTIAL_TARGET_PREFIX, suffix)
}

/// Convert a persist string to a CRED_PERSIST value.
fn persist_to_value(persist: &str) -> windows::Win32::Security::Credentials::CRED_PERSIST {
    match persist {
        "session" => CRED_PERSIST_SESSION,
        "enterprise" => CRED_PERSIST_ENTERPRISE,
        "local_machine" | _ => CRED_PERSIST_LOCAL_MACHINE,
    }
}

/// Write a credential to Windows Credential Manager.
pub fn write_credential(spec: &CredentialSpec) -> Result<bool> {
    let target_vec: Vec<u16> = spec.target_name.encode_utf16().chain(Some(0)).collect();
    let blob_vec: Vec<u8> = spec.credential_blob.as_bytes().to_vec();

    let user_vec: Option<Vec<u16>> = spec
        .user_name
        .as_ref()
        .map(|u| u.encode_utf16().chain(Some(0)).collect());

    let comment_vec: Option<Vec<u16>> = spec
        .comment
        .as_ref()
        .map(|c| c.encode_utf16().chain(Some(0)).collect());

    let persist = persist_to_value(spec.persist.as_deref().unwrap_or("local_machine"));

    let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
    credential.Flags = windows::Win32::Security::Credentials::CRED_FLAGS(0);
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = PWSTR::from_raw(target_vec.as_ptr() as *mut u16);
    credential.TargetAlias = PWSTR::null();
    credential.Comment = match &comment_vec {
        Some(v) => PWSTR::from_raw(v.as_ptr() as *mut u16),
        None => PWSTR::null(),
    };
    credential.LastWritten = unsafe { std::mem::zeroed() };
    credential.CredentialBlobSize = blob_vec.len() as u32;
    credential.CredentialBlob = blob_vec.as_ptr() as *mut u8;
    credential.Persist = persist;
    credential.AttributeCount = 0;
    credential.Attributes = std::ptr::null_mut();
    credential.UserName = match &user_vec {
        Some(v) => PWSTR::from_raw(v.as_ptr() as *mut u16),
        None => PWSTR::null(),
    };

    unsafe { CredWriteW(&credential, 0)? };

    Ok(true)
}

/// Read a credential from Windows Credential Manager.
pub fn read_credential(target_name: &str) -> Result<Option<(String, Option<String>)>> {
    let target_vec: Vec<u16> = target_name.encode_utf16().chain(Some(0)).collect();

    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    unsafe {
        CredReadW(
            PCWSTR::from_raw(target_vec.as_ptr()),
            CRED_TYPE_GENERIC,
            0,
            &mut credential,
        )?;
    }

    if credential.is_null() {
        return Ok(None);
    }

    let cred = unsafe { credential.as_ref() }.unwrap();

    let blob = if cred.CredentialBlobSize > 0 && !cred.CredentialBlob.is_null() {
        let blob_slice = unsafe {
            std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
        };
        String::from_utf8_lossy(blob_slice).to_string()
    } else {
        String::new()
    };

    let user_name = if !cred.UserName.is_null() {
        unsafe { Some(cred.UserName.to_string().unwrap_or_default()) }
    } else {
        None
    };

    Ok(Some((blob, user_name)))
}

/// Delete a credential from Windows Credential Manager.
pub fn delete_credential(target_name: &str) -> Result<bool> {
    let target_vec: Vec<u16> = target_name.encode_utf16().chain(Some(0)).collect();

    match unsafe {
        CredDeleteW(PCWSTR::from_raw(target_vec.as_ptr()), CRED_TYPE_GENERIC, 0)
    } {
        Ok(()) => Ok(true),
        Err(err) => {
            // ERROR_NOT_FOUND = 2 (0x2)
            if err.code().0 == 2i32 {
                Ok(false)
            } else {
                Err(err)
            }
        }
    }
}

/// List credentials matching an optional filter.
pub fn list_credentials(filter: Option<&str>) -> Result<Vec<CredentialListEntry>> {
    let mut count: u32 = 0;
    let credentials: *mut *mut *mut CREDENTIALW = std::ptr::null_mut();

    let filter_ptr = match filter {
        Some(f) => {
            let vec: Vec<u16> = f.encode_utf16().chain(Some(0)).collect();
            PCWSTR::from_raw(vec.as_ptr())
        }
        None => PCWSTR::null(),
    };

    unsafe {
        windows::Win32::Security::Credentials::CredEnumerateW(
            filter_ptr,
            windows::Win32::Security::Credentials::CRED_ENUMERATE_FLAGS(0),
            &mut count,
            credentials,
        )?;
    }

    let mut results = Vec::new();

    for i in 0..count as usize {
        let cred_ptr = unsafe { credentials.add(i).read() };

        let target_name = unsafe {
            (*(*cred_ptr)).TargetName.to_string().unwrap_or_default()
        };
        let user_name = unsafe {
            if !(*(*cred_ptr)).UserName.is_null() {
                Some((*(*cred_ptr)).UserName.to_string().unwrap_or_default())
            } else {
                None
            }
        };
        let comment = unsafe {
            if !(*(*cred_ptr)).Comment.is_null() {
                Some((*(*cred_ptr)).Comment.to_string().unwrap_or_default())
            } else {
                None
            }
        };

        results.push(CredentialListEntry {
            target_name,
            user_name,
            comment,
        });
    }

    Ok(results)
}

/// Handle a credential write request.
pub fn handle_cm_write(
    request: &CredentialWriteRequest,
) -> Result<crate::protocol::LaunchResponse> {
    let success = write_credential(&request.credential)?;
    Ok(crate::protocol::LaunchResponse::CmCredentialWritten {
        version: request.version,
        target_name: request.credential.target_name.clone(),
        success,
    })
}

/// Handle a credential read request.
pub fn handle_cm_read(
    request: &CredentialReadRequest,
) -> Result<crate::protocol::LaunchResponse> {
    let result = read_credential(&request.target_name)?;
    Ok(crate::protocol::LaunchResponse::CmCredentialRead {
        version: request.version,
        target_name: request.target_name.clone(),
        credential_blob: result.as_ref().map(|(blob, _)| blob.clone()),
        user_name: result.as_ref().and_then(|(_, user)| user.clone()),
        found: result.is_some(),
    })
}

/// Handle a credential delete request.
pub fn handle_cm_delete(
    request: &CredentialDeleteRequest,
) -> Result<crate::protocol::LaunchResponse> {
    let success = delete_credential(&request.target_name)?;
    Ok(crate::protocol::LaunchResponse::CmCredentialDeleted {
        version: request.version,
        target_name: request.target_name.clone(),
        success,
    })
}

/// Handle a credential list request.
pub fn handle_cm_list(
    request: &CredentialListRequest,
) -> Result<crate::protocol::LaunchResponse> {
    let filter = request.filter.as_deref();
    let credentials = list_credentials(filter)?;
    Ok(crate::protocol::LaunchResponse::CmCredentialsListed {
        version: request.version,
        credentials,
    })
}
