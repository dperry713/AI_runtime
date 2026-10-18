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
}
