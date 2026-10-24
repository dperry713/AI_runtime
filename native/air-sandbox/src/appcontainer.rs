/**
 * Windows AppContainer isolation for air-sandbox.exe.
 *
 * Provides AppContainer profile management via PowerShell:
 * - New-AppContainerProfile / Remove-AppContainerProfile for profile lifecycle
 * - SID derivation for use with WFP filters and filesystem ACLs
 *
 * AppContainer is the Windows equivalent of Landlock/seccomp-bpf: a
 * kernel-enforced sandbox that restricts process capabilities regardless of
 * environment variables. Process launching inside an AppContainer is handled
 * by the TypeScript layer using the profile SID for WFP filtering and ACLs.
 */

use std::collections::HashMap;

/// In-memory registry of AppContainer profiles created by this helper instance.
static mut PROFILES: Option<HashMap<String, String>> = None;

fn profiles() -> &'static mut HashMap<String, String> {
    unsafe {
        if PROFILES.is_none() {
            PROFILES = Some(HashMap::new());
        }
        PROFILES.as_mut().unwrap()
    }
}

/// Convert a capability enum to its string name.
fn capability_to_string(cap: &crate::protocol::AppContainerCapability) -> &'static str {
    match cap {
        crate::protocol::AppContainerCapability::InternetClient => "internetClient",
        crate::protocol::AppContainerCapability::InternetClientServer => "internetClientServer",
        crate::protocol::AppContainerCapability::PrivateNetworkClientServer => {
            "privateNetworkClientServer"
        }
        crate::protocol::AppContainerCapability::DocumentsLibrary => "documentsLibrary",
        crate::protocol::AppContainerCapability::PicturesLibrary => "picturesLibrary",
        crate::protocol::AppContainerCapability::MusicLibrary => "musicLibrary",
        crate::protocol::AppContainerCapability::VideosLibrary => "videosLibrary",
        crate::protocol::AppContainerCapability::RemovableStorage => "removableStorage",
        crate::protocol::AppContainerCapability::EnterpriseAuthentication => {
            "enterpriseAuthentication"
        }
        crate::protocol::AppContainerCapability::SharedUserCertificates => "sharedUserCertificates",
        crate::protocol::AppContainerCapability::DocumentsLibraryReadWrite => {
            "documentsLibraryReadWrite"
        }
    }
}

/// Create an AppContainer profile using PowerShell New-AppContainerProfile.
pub fn create_profile(spec: &crate::protocol::AppContainerProfileSpec) -> Result<crate::protocol::AppContainerProfileResult, String> {
    let caps_str: String = spec
        .capabilities
        .iter()
        .map(capability_to_string)
        .collect::<Vec<_>>()
        .join(",");

    let caps_arg = if caps_str.is_empty() {
        String::new()
    } else {
        format!("-Capabilities {}", caps_str)
    };

    let desc_arg = match &spec.description {
        Some(d) => format!("-Description \"{}\"", d),
        None => String::new(),
    };

    let command = format!(
        "New-AppContainerProfile -Name \"{}\" -DisplayName \"{}\" {} {} | Select-Object -ExpandProperty AppContainerSid",
        spec.name, spec.display_name, desc_arg, caps_arg
    );

    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &command,
        ])
        .output()
        .map_err(|e| format!("Failed to execute powershell: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("New-AppContainerProfile failed: {}", stderr));
    }

    let sid = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_string();

    if sid.is_empty() {
        return Err("New-AppContainerProfile returned empty SID".to_string());
    }

    // Track the profile
    profiles().insert(spec.name.clone(), sid.clone());

    Ok(crate::protocol::AppContainerProfileResult {
        name: spec.name.clone(),
        sid,
        capabilities: spec.capabilities.clone(),
        success: true,
        message: "AppContainer profile created successfully".to_string(),
    })
}

/// Delete an AppContainer profile using PowerShell Remove-AppContainerProfile.
pub fn delete_profile(name: &str) -> Result<bool, String> {
    let command = format!(
        "Remove-AppContainerProfile -Name \"{}\" -ErrorAction SilentlyContinue",
        name
    );

    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &command,
        ])
        .output()
        .map_err(|e| format!("Failed to execute powershell: {}", e))?;

    profiles().remove(name);
    Ok(output.status.success())
}

/// List all AppContainer profiles tracked by this helper.
pub fn list_profiles() -> Result<crate::protocol::AppContainerListProfilesResponse, String> {
    let profiles_map = profiles();
    let mut results = Vec::new();

    for (name, sid) in profiles_map.iter() {
        results.push(crate::protocol::AppContainerProfileResult {
            name: name.clone(),
            sid: sid.clone(),
            capabilities: Vec::new(),
            success: true,
            message: "AppContainer profile active".to_string(),
        });
    }

    Ok(crate::protocol::AppContainerListProfilesResponse {
        version: 1,
        profiles: results,
    })
}

/// Grant filesystem access to an AppContainer SID via icacls.
pub fn grant_access(sid: &str, target_path: &str, access: &str) -> Result<crate::protocol::AppContainerGrantAccessResult, String> {
    let rights = if access == "full" { "F" } else { "RX" };
    let grant_arg = format!("*{}:(OI)(CI){}", sid, rights);

    let output = std::process::Command::new("icacls")
        .args([target_path, "/grant", &grant_arg, "/T", "/C", "/Q"])
        .output()
        .map_err(|e| format!("Failed to execute icacls: {}", e))?;

    if output.status.success() {
        Ok(crate::protocol::AppContainerGrantAccessResult {
            sid: sid.to_string(),
            target_path: target_path.to_string(),
            success: true,
            message: "Access successfully granted".to_string(),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("icacls failed: {}", stderr))
    }
}

/// Handle an AppContainer create-profile request.
pub fn handle_ac_create_profile(
    request: &crate::protocol::AppContainerCreateProfileRequest,
) -> Result<crate::protocol::LaunchResponse, String> {
    let result = create_profile(&request.profile)?;
    Ok(crate::protocol::LaunchResponse::AcProfileCreated {
        version: request.version,
        profile: result,
    })
}

/// Handle an AppContainer delete-profile request.
pub fn handle_ac_delete_profile(
    request: &crate::protocol::AppContainerDeleteProfileRequest,
) -> Result<crate::protocol::LaunchResponse, String> {
    let success = delete_profile(&request.name)?;
    Ok(crate::protocol::LaunchResponse::AcProfileDeleted {
        version: request.version,
        name: request.name.clone(),
        success,
    })
}

/// Handle an AppContainer list-profiles request.
pub fn handle_ac_list_profiles(
    _request: &crate::protocol::AppContainerListProfilesRequest,
) -> Result<crate::protocol::LaunchResponse, String> {
    let response = list_profiles()?;
    Ok(crate::protocol::LaunchResponse::AcProfilesListed {
        version: response.version,
        profiles: response.profiles,
    })
}

/// Handle an AppContainer grant-access request.
pub fn handle_ac_grant_access(
    request: &crate::protocol::AppContainerGrantAccessRequest,
) -> Result<crate::protocol::LaunchResponse, String> {
    let result = grant_access(&request.sid, &request.target_path, &request.access)?;
    Ok(crate::protocol::LaunchResponse::AcAccessGranted {
        version: request.version,
        result,
    })
}
