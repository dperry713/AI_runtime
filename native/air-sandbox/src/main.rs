mod job;
mod protocol;
mod token;
mod wfp;
mod appcontainer;
mod cred;

use job::JobObject;
use protocol::{LaunchRequest, LaunchResponse, PROTOCOL_VERSION};
use wfp::{handle_wfp_add_filter, handle_wfp_list_filters, handle_wfp_remove_filter};
use appcontainer::{
    handle_ac_create_profile, handle_ac_delete_profile, handle_ac_grant_access,
    handle_ac_list_profiles,
};
use cred::{
    handle_cm_delete, handle_cm_list, handle_cm_read, handle_cm_write,
};
use std::ffi::OsStr;
use std::io::{self, BufRead, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use token::RestrictedToken;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, ResumeThread, WaitForSingleObject,
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, INFINITE, PROCESS_INFORMATION, STARTUPINFOW,
};

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn emit_response(resp: &LaunchResponse) {
    if let Ok(json) = serde_json::to_string(resp) {
        println!("{}", json);
        let _ = io::stdout().flush();
    }
}

fn emit_error(code: &str, msg: &str) {
    emit_response(&LaunchResponse::Error {
        version: PROTOCOL_VERSION,
        code: code.to_string(),
        message: msg.to_string(),
    });
}

fn build_command_line(cmd: &str, args: &[String]) -> String {
    let mut out = String::new();
    if cmd.contains(' ') {
        out.push('"');
        out.push_str(cmd);
        out.push('"');
    } else {
        out.push_str(cmd);
    }

    for arg in args {
        out.push(' ');
        if arg.contains(' ') || arg.contains('\t') || arg.is_empty() {
            out.push('"');
            out.push_str(&arg.replace('"', "\\\""));
            out.push('"');
        } else {
            out.push_str(arg);
        }
    }
    out
}

fn build_environment_block(env: &std::collections::HashMap<String, String>) -> Vec<u16> {
    let mut block = Vec::new();
    for (k, v) in env {
        let entry = format!("{}={}", k, v);
        block.extend(OsStr::new(&entry).encode_wide());
        block.push(0);
    }
    block.push(0); // Double null termination
    block
}

fn run_helper() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut line = String::new();
    stdin.lock().read_line(&mut line)?;

    if line.trim().is_empty() {
        emit_error("INVALID_REQUEST", "Empty request received on stdin");
        return Ok(());
    }

    let request: LaunchRequest = match serde_json::from_str(&line) {
        Ok(req) => req,
        Err(err) => {
            emit_error("PARSE_ERROR", &format!("Malformed JSON request: {}", err));
            return Ok(());
        }
    };

    if request.version != PROTOCOL_VERSION {
        emit_error(
            "VERSION_MISMATCH",
            &format!(
                "Unsupported protocol version: {}, expected {}",
                request.version, PROTOCOL_VERSION
            ),
        );
        return Ok(());
    }

    // WFP operations take precedence over process launching.
    if request.wfp_list_filters == Some(true) {
        match handle_wfp_list_filters(request.version) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("WFP_LIST_FAILED", &err.to_string()),
        }
        return Ok(());
    }

    if let Some(filter_id) = request.wfp_remove_filter_id {
        match handle_wfp_remove_filter(filter_id, request.version) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("WFP_REMOVE_FAILED", &err.to_string()),
        }
        return Ok(());
    }

    if let Some(filter_spec) = &request.wfp_add_filter {
        let wfp_request = protocol::WfpAddFilterRequest {
            version: request.version,
            filter: filter_spec.clone(),
        };
        match handle_wfp_add_filter(&wfp_request) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("WFP_ADD_FAILED", &err.to_string()),
        }
        return Ok(());
    }

    // AppContainer operations take precedence over process launching.
    if request.ac_list_profiles == Some(true) {
        match handle_ac_list_profiles(&protocol::AppContainerListProfilesRequest {
            version: request.version,
        }) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("AC_LIST_FAILED", &err),
        }
        return Ok(());
    }

    if let Some(create_req) = &request.ac_create_profile {
        match handle_ac_create_profile(create_req) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("AC_CREATE_FAILED", &err),
        }
        return Ok(());
    }

    if let Some(delete_req) = &request.ac_delete_profile {
        match handle_ac_delete_profile(delete_req) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("AC_DELETE_FAILED", &err),
        }
        return Ok(());
    }

    if let Some(grant_req) = &request.ac_grant_access {
        match handle_ac_grant_access(grant_req) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("AC_GRANT_FAILED", &err),
        }
        return Ok(());
    }

    if let Some(_launch_req) = &request.ac_launch {
        // AppContainer process launching is handled from the TypeScript layer
        // using the profile SID for WFP filtering and ACLs.
        emit_error(
            "AC_LAUNCH_NOT_SUPPORTED",
            "AppContainer process launching is handled by the TypeScript layer; use ac_create_profile and ac_grant_access instead",
        );
        return Ok(());
    }

    // Credential Manager operations.
    if let Some(write_req) = &request.cm_write {
        match handle_cm_write(write_req) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("CM_WRITE_FAILED", &err.to_string()),
        }
        return Ok(());
    }

    if let Some(read_req) = &request.cm_read {
        match handle_cm_read(read_req) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("CM_READ_FAILED", &err.to_string()),
        }
        return Ok(());
    }

    if let Some(delete_req) = &request.cm_delete {
        match handle_cm_delete(delete_req) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("CM_DELETE_FAILED", &err.to_string()),
        }
        return Ok(());
    }

    if let Some(list_req) = &request.cm_list {
        match handle_cm_list(list_req) {
            Ok(resp) => emit_response(&resp),
            Err(err) => emit_error("CM_LIST_FAILED", &err.to_string()),
        }
        return Ok(());
    }

    if request.command.trim().is_empty() {
        emit_error("INVALID_ARGUMENT", "Command cannot be empty");
        return Ok(());
    }

    // 1. Working Directory Validation
    if let Some(ref cwd) = request.cwd {
        let path = Path::new(cwd);
        if !path.exists() {
            emit_error(
                "DIRECTORY_NOT_FOUND",
                &format!("Working directory does not exist: {}", cwd),
            );
            return Ok(());
        }
    }

    // 2. Job Object Setup
    let job = match JobObject::create() {
        Ok(j) => j,
        Err(err) => {
            emit_error("JOB_CREATE_FAILED", &format!("Failed to create Job Object: {}", err));
            return Ok(());
        }
    };

    let kill_on_close = request
        .limits
        .as_ref()
        .and_then(|l| l.kill_on_close)
        .unwrap_or(true);
    let max_proc = request.limits.as_ref().and_then(|l| l.max_processes);
    let max_mem = request.limits.as_ref().and_then(|l| l.max_memory_bytes);
    let cpu_rate = request.limits.as_ref().and_then(|l| l.cpu_rate_limit_percent);

    if let Err(err) = job.set_limits(kill_on_close, max_proc, max_mem, cpu_rate) {
        emit_error(
            "JOB_LIMITS_FAILED",
            &format!("Failed to set Job Object limits: {}", err),
        );
        return Ok(());
    }

    // 3. Optional Restricted Token
    let _token = if request.restricted_token {
        match RestrictedToken::create() {
            Ok(t) => Some(t),
            Err(err) => {
                emit_error(
                    "TOKEN_RESTRICT_FAILED",
                    &format!("Failed to create restricted token: {}", err),
                );
                return Ok(());
            }
        }
    } else {
        None
    };

    // 4. Command Line & Environment Assembly
    let cmd_line = build_command_line(&request.command, &request.args);
    let mut wide_cmd_line = to_wide(&cmd_line);

    let wide_cwd = request.cwd.as_ref().map(|c| to_wide(c));
    let cwd_ptr = match wide_cwd {
        Some(ref w) => PCWSTR::from_raw(w.as_ptr()),
        None => PCWSTR::null(),
    };

    let env_block = if !request.env.is_empty() {
        Some(build_environment_block(&request.env))
    } else {
        None
    };
    let env_ptr = match env_block {
        Some(ref b) => b.as_ptr() as *const _,
        None => std::ptr::null(),
    };

    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;

    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;

    let success = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            PWSTR::from_raw(wide_cmd_line.as_mut_ptr()),
            None,
            None,
            false,
            flags,
            Some(env_ptr),
            cwd_ptr,
            &si,
            &mut pi,
        )
    };

    if let Err(err) = success {
        emit_error(
            "SPAWN_FAILED",
            &format!("CreateProcessW failed for \"{}\": {}", cmd_line, err),
        );
        return Ok(());
    }

    // 5. Assign to Job Object before resuming thread
    if let Err(err) = job.assign_process(pi.hProcess) {
        unsafe {
            let _ = CloseHandle(pi.hThread);
            let _ = CloseHandle(pi.hProcess);
        }
        emit_error(
            "JOB_ASSIGN_FAILED",
            &format!("AssignProcessToJobObject failed: {}", err),
        );
        return Ok(());
    }

    // 6. Resume main thread
    unsafe {
        ResumeThread(pi.hThread);
        let _ = CloseHandle(pi.hThread);
    }

    // 7. Emit Started event with PID
    emit_response(&LaunchResponse::Started {
        version: PROTOCOL_VERSION,
        pid: pi.dwProcessId,
    });

    // 8. Wait for Process Exit
    unsafe {
        WaitForSingleObject(pi.hProcess, INFINITE);
    }

    // 9. Collect Exit Code & Job Metrics
    let mut exit_code: u32 = 0;
    unsafe {
        let _ = GetExitCodeProcess(pi.hProcess, &mut exit_code);
        let _ = CloseHandle(pi.hProcess);
    }

    let (peak_mem, cpu_ms) = job.query_metrics().unwrap_or((0, 0));

    // 10. Emit Completed event
    emit_response(&LaunchResponse::Completed {
        version: PROTOCOL_VERSION,
        exit_code: exit_code as i32,
        peak_memory_bytes: peak_mem,
        total_cpu_time_ms: cpu_ms,
    });

    Ok(())
}

fn main() {
    if let Err(err) = run_helper() {
        emit_error("CRASH", &format!("Fatal helper error: {}", err));
    }
}
