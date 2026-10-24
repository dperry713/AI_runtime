/**
 * Windows Filtering Platform (WFP) filter management for air-sandbox.exe.
 *
 * Provides kernel-level outbound connection filtering independent of
 * environment variables. On modern Windows (Windows 8+/Server 2012+),
 * `netsh advfirewall` operates on top of the Windows Filtering Platform,
 * providing kernel-enforced packet filtering that cannot be bypassed by
 * child processes ignoring HTTP_PROXY/HTTPS_PROXY environment variables.
 *
 * All operations are executed via `netsh advfirewall` commands, which
 * translate to WFP filters at the kernel level.
 */

use std::process::Command;
use crate::protocol::{WfpAddFilterRequest, WfpFilterSpec};

const AIR_WFP_RULE_PREFIX: &str = "AIR WFP ";

/// Add a WFP filter (netsh advfirewall rule) to block or permit outbound
/// connections based on remote address, port, and protocol.
pub fn add_filter(spec: &WfpFilterSpec) -> Result<(u64, String), String> {
    let rule_name = format!("{}{}", AIR_WFP_RULE_PREFIX, spec.name);

    // Remove any existing rule with the same name
    let _ = Command::new("netsh")
        .args([
            "advfirewall", "firewall", "delete", "rule",
            &format!("name={}", rule_name),
        ])
        .output();

    let action = match spec.action.to_lowercase().as_str() {
        "permit" => "allow",
        _ => "block",
    };

    let mut args: Vec<String> = vec![
        "advfirewall".to_string(),
        "firewall".to_string(),
        "add".to_string(),
        "rule".to_string(),
        format!("name={}", rule_name),
        "dir=out".to_string(),
        format!("action={}", action),
        "enable=yes".to_string(),
    ];

    // Add protocol condition
    if let Some(proto) = spec.ip_protocol {
        let proto_str = match proto {
            6 => "tcp",
            17 => "udp",
            1 => "icmpv4",
            58 => "icmpv6",
            _ => "any",
        };
        args.push(format!("protocol={}", proto_str));
    }

    // Add remote port condition
    if let Some(port_range) = &spec.remote_port {
        args.push(format!("remoteport={}", port_range));
    }

    // Add remote address condition
    if let Some(addr) = &spec.remote_address {
        args.push(format!("remoteip={}", addr));
    }

    // Add local port condition
    if let Some(port_range) = &spec.local_port {
        args.push(format!("localport={}", port_range));
    }

    // Add local address condition
    if let Some(addr) = &spec.local_address {
        args.push(format!("localip={}", addr));
    }

    // Program path condition (if package family name is specified, use it as
    // a proxy for the AppContainer/package identity)
    if let Some(pfn) = &spec.package_family_name {
        args.push(format!("program={}", pfn));
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = Command::new("netsh").args(&arg_refs).output()
        .map_err(|e| format!("Failed to execute netsh: {}", e))?;

    if output.status.success() {
        // Generate a deterministic filter ID from the rule name hash
        let filter_id = hash_rule_name(&rule_name);
        Ok((filter_id, spec.name.clone()))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("netsh failed: {}", stderr))
    }
}

/// Remove a WFP filter (netsh advfirewall rule) by ID.
pub fn remove_filter(filter_id: u64) -> Result<bool, String> {
    // We don't have a direct mapping from filter_id to rule name without
    // tracking. List all AIR WFP rules and remove the one matching the hash.
    let output = Command::new("netsh")
        .args([
            "advfirewall", "firewall", "show", "rule",
            "name=all",
        ])
        .output()
        .map_err(|e| format!("Failed to execute netsh: {}", e))?;

    if !output.status.success() {
        return Err("netsh show rule failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let line = line.trim();
        if line.starts_with("Rule Name:") {
            if let Some(name) = line.strip_prefix("Rule Name:") {
                let name = name.trim();
                if name.starts_with(AIR_WFP_RULE_PREFIX) {
                    let id = hash_rule_name(name);
                    if id == filter_id {
                        let remove_output = Command::new("netsh")
                            .args([
                                "advfirewall", "firewall", "delete", "rule",
                                &format!("name={}", name),
                            ])
                            .output()
                            .map_err(|e| format!("Failed to execute netsh: {}", e))?;
                        return Ok(remove_output.status.success());
                    }
                }
            }
        }
    }

    Ok(false)
}

/// List WFP filters (netsh advfirewall rules with AIR prefix).
pub fn list_filters() -> Result<Vec<(u64, String)>, String> {
    let output = Command::new("netsh")
        .args([
            "advfirewall", "firewall", "show", "rule",
            "name=all",
        ])
        .output()
        .map_err(|e| format!("Failed to execute netsh: {}", e))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut filters = Vec::new();
    let mut current_name: Option<String> = None;

    for line in stdout.lines() {
        let line = line.trim();
        if line.starts_with("Rule Name:") {
            if let Some(name) = line.strip_prefix("Rule Name:") {
                let name = name.trim();
                if name.starts_with(AIR_WFP_RULE_PREFIX) {
                    current_name = Some(name.to_string());
                } else {
                    current_name = None;
                }
            }
        } else if line.starts_with("Enabled:") && current_name.is_some() {
            let enabled = line.split(':').nth(1).map(|s| s.trim() == "Yes").unwrap_or(false);
            if enabled {
                if let Some(name) = current_name.take() {
                    let filter_id = hash_rule_name(&name);
                    let display_name = name.strip_prefix(AIR_WFP_RULE_PREFIX).unwrap_or(&name).to_string();
                    filters.push((filter_id, display_name));
                }
            }
        }
    }

    Ok(filters)
}

/// Hash a rule name to a deterministic u64 filter ID.
fn hash_rule_name(name: &str) -> u64 {
    let mut hash: u64 = 14695981039346656037; // FNV offset basis
    for byte in name.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(1099511628211); // FNV prime
    }
    hash
}

/// Process a WFP add-filter request from the TypeScript client.
pub fn handle_wfp_add_filter(
    request: &WfpAddFilterRequest,
) -> Result<crate::protocol::LaunchResponse, String> {
    let (filter_id, name) = add_filter(&request.filter)?;
    Ok(crate::protocol::LaunchResponse::WfpFilterAdded {
        version: request.version,
        filter_id,
        name,
    })
}

/// Process a WFP remove-filter request.
pub fn handle_wfp_remove_filter(
    filter_id: u64,
    version: u32,
) -> Result<crate::protocol::LaunchResponse, String> {
    let success = remove_filter(filter_id)?;
    Ok(crate::protocol::LaunchResponse::WfpFilterRemoved {
        version,
        filter_id,
        success,
    })
}

/// Process a WFP list-filters request.
pub fn handle_wfp_list_filters(version: u32) -> Result<crate::protocol::LaunchResponse, String> {
    let filters = list_filters()?;
    Ok(crate::protocol::LaunchResponse::WfpFiltersListed {
        version,
        filters: filters
            .into_iter()
            .map(|(id, name)| crate::protocol::WfpFilterResult {
                filter_id: id,
                name,
                success: true,
                message: "WFP filter active (netsh advfirewall)".to_string(),
            })
            .collect(),
    })
}
