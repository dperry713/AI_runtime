use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobLimits {
    pub max_memory_bytes: Option<u64>,
    pub max_processes: Option<u32>,
    pub cpu_rate_limit_percent: Option<u32>,
    pub kill_on_close: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WfpFilterSpec {
    /// Human-readable filter name.
    pub name: String,
    /// IP protocol (6 = TCP, 17 = UDP, 255 = any).
    pub ip_protocol: Option<u8>,
    /// Remote port or port range (e.g. "443" or "1024-65535").
    pub remote_port: Option<String>,
    /// Remote address prefix (CIDR, e.g. "0.0.0.0/0" or specific IP).
    pub remote_address: Option<String>,
    /// Local port or port range.
    pub local_port: Option<String>,
    /// Local address prefix (CIDR).
    pub local_address: Option<String>,
    /// AppContainer SID to scope the filter to (optional).
    pub app_container_sid: Option<String>,
    /// Process image name to scope the filter to (optional).
    pub package_family_name: Option<String>,
    /// Action: "block" or "permit".
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WfpFilterResult {
    pub filter_id: u64,
    pub name: String,
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WfpAddFilterRequest {
    pub version: u32,
    pub filter: WfpFilterSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WfpRemoveFilterRequest {
    pub version: u32,
    pub filter_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WfpListFiltersRequest {
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WfpListFiltersResponse {
    pub version: u32,
    pub filters: Vec<WfpFilterResult>,
}

// ============================================================================
// AppContainer types
// ============================================================================

/// Standard Windows AppContainer capability identifiers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppContainerCapability {
    InternetClient,
    InternetClientServer,
    PrivateNetworkClientServer,
    DocumentsLibrary,
    PicturesLibrary,
    MusicLibrary,
    VideosLibrary,
    RemovableStorage,
    EnterpriseAuthentication,
    SharedUserCertificates,
    DocumentsLibraryReadWrite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerProfileSpec {
    /// Human-readable profile name.
    pub name: String,
    /// Display name for the profile.
    pub display_name: String,
    /// Optional description.
    pub description: Option<String>,
    /// Capabilities to grant (e.g. internetClient for outbound network).
    pub capabilities: Vec<AppContainerCapability>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerProfileResult {
    pub name: String,
    pub sid: String,
    pub capabilities: Vec<AppContainerCapability>,
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerCreateProfileRequest {
    pub version: u32,
    pub profile: AppContainerProfileSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerDeleteProfileRequest {
    pub version: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerListProfilesRequest {
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerListProfilesResponse {
    pub version: u32,
    pub profiles: Vec<AppContainerProfileResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerLaunchSpec {
    /// Name of the AppContainer profile to launch in.
    pub profile_name: String,
    /// Command to execute.
    pub command: String,
    /// Command line arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// Working directory.
    pub cwd: Option<String>,
    /// Environment variables.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Job object limits (optional).
    pub limits: Option<JobLimits>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerLaunchRequest {
    pub version: u32,
    pub launch: AppContainerLaunchSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerLaunchResult {
    pub profile_name: String,
    pub sid: String,
    pub pid: u32,
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerGrantAccessRequest {
    pub version: u32,
    pub sid: String,
    pub target_path: String,
    pub access: String, // "read" or "full"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContainerGrantAccessResult {
    pub sid: String,
    pub target_path: String,
    pub success: bool,
    pub message: String,
}

// ============================================================================
// Windows Credential Manager types
// ============================================================================

/// Specification for a Windows Credential Manager credential.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialSpec {
    /// Target name for the credential (e.g. "AIR:MasterKey:<vault-dir>").
    pub target_name: String,
    /// Secret value (password/credential blob).
    pub credential_blob: String,
    /// Optional user name associated with the credential.
    pub user_name: Option<String>,
    /// Optional comment/description.
    pub comment: Option<String>,
    /// Persistence: "session", "enterprise", or "local_machine".
    pub persist: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialResult {
    pub target_name: String,
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialWriteRequest {
    pub version: u32,
    pub credential: CredentialSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialReadRequest {
    pub version: u32,
    pub target_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialReadResponse {
    pub version: u32,
    pub target_name: String,
    pub credential_blob: Option<String>,
    pub user_name: Option<String>,
    pub found: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialDeleteRequest {
    pub version: u32,
    pub target_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialListRequest {
    pub version: u32,
    pub filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialListEntry {
    pub target_name: String,
    pub user_name: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialListResponse {
    pub version: u32,
    pub credentials: Vec<CredentialListEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchRequest {
    pub version: u32,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub limits: Option<JobLimits>,
    #[serde(default)]
    pub restricted_token: bool,
    /// Optional WFP operation. When present, performs WFP filter management
    /// instead of process launching.
    #[serde(default)]
    pub wfp_add_filter: Option<WfpFilterSpec>,
    #[serde(default)]
    pub wfp_remove_filter_id: Option<u64>,
    #[serde(default)]
    pub wfp_list_filters: Option<bool>,
    /// Optional AppContainer operations.
    #[serde(default)]
    pub ac_create_profile: Option<AppContainerCreateProfileRequest>,
    #[serde(default)]
    pub ac_delete_profile: Option<AppContainerDeleteProfileRequest>,
    #[serde(default)]
    pub ac_list_profiles: Option<bool>,
    #[serde(default)]
    pub ac_launch: Option<AppContainerLaunchRequest>,
    #[serde(default)]
    pub ac_grant_access: Option<AppContainerGrantAccessRequest>,
    /// Optional Credential Manager operations.
    #[serde(default)]
    pub cm_write: Option<CredentialWriteRequest>,
    #[serde(default)]
    pub cm_read: Option<CredentialReadRequest>,
    #[serde(default)]
    pub cm_delete: Option<CredentialDeleteRequest>,
    #[serde(default)]
    pub cm_list: Option<CredentialListRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LaunchResponse {
    #[serde(rename = "started")]
    Started {
        version: u32,
        pid: u32,
    },
    #[serde(rename = "completed")]
    Completed {
        version: u32,
        exit_code: i32,
        peak_memory_bytes: u64,
        total_cpu_time_ms: u64,
    },
    #[serde(rename = "error")]
    Error {
        version: u32,
        message: String,
        code: String,
    },
    #[serde(rename = "wfp_filter_added")]
    WfpFilterAdded {
        version: u32,
        filter_id: u64,
        name: String,
    },
    #[serde(rename = "wfp_filter_removed")]
    WfpFilterRemoved {
        version: u32,
        filter_id: u64,
        success: bool,
    },
    #[serde(rename = "wfp_filters_listed")]
    WfpFiltersListed {
        version: u32,
        filters: Vec<WfpFilterResult>,
    },
    #[serde(rename = "ac_profile_created")]
    AcProfileCreated {
        version: u32,
        profile: AppContainerProfileResult,
    },
    #[serde(rename = "ac_profile_deleted")]
    AcProfileDeleted {
        version: u32,
        name: String,
        success: bool,
    },
    #[serde(rename = "ac_profiles_listed")]
    AcProfilesListed {
        version: u32,
        profiles: Vec<AppContainerProfileResult>,
    },
    #[serde(rename = "ac_process_launched")]
    AcProcessLaunched {
        version: u32,
        result: AppContainerLaunchResult,
    },
    #[serde(rename = "ac_access_granted")]
    AcAccessGranted {
        version: u32,
        result: AppContainerGrantAccessResult,
    },
    #[serde(rename = "cm_credential_written")]
    CmCredentialWritten {
        version: u32,
        target_name: String,
        success: bool,
    },
    #[serde(rename = "cm_credential_read")]
    CmCredentialRead {
        version: u32,
        target_name: String,
        credential_blob: Option<String>,
        user_name: Option<String>,
        found: bool,
    },
    #[serde(rename = "cm_credential_deleted")]
    CmCredentialDeleted {
        version: u32,
        target_name: String,
        success: bool,
    },
    #[serde(rename = "cm_credentials_listed")]
    CmCredentialsListed {
        version: u32,
        credentials: Vec<CredentialListEntry>,
    },
}
