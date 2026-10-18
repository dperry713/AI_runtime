use std::mem::size_of;
use windows::core::Result;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY,
};

pub struct JobObject {
    handle: HANDLE,
}

impl JobObject {
    pub fn create() -> Result<Self> {
        let handle = unsafe { CreateJobObjectW(None, None)? };
        Ok(Self { handle })
    }

    pub fn set_limits(
        &self,
        kill_on_close: bool,
        max_processes: Option<u32>,
        max_memory_bytes: Option<u64>,
        cpu_rate_percent: Option<u32>,
    ) -> Result<()> {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let mut flags = JOB_OBJECT_LIMIT(0);

        if kill_on_close {
            flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        }

        if let Some(processes) = max_processes {
            flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = processes;
        }

        if let Some(mem) = max_memory_bytes {
            flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.ProcessMemoryLimit = mem as usize;
            info.JobMemoryLimit = mem as usize;
        }

        info.BasicLimitInformation.LimitFlags = flags;

        unsafe {
            SetInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )?;
        }

        if let Some(cpu_pct) = cpu_rate_percent {
            if cpu_pct > 0 && cpu_pct <= 100 {
                let mut cpu_info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
                    ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE
                        | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                    Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 {
                        CpuRate: cpu_pct * 100, // 10000 = 100%
                    },
                };

                unsafe {
                    SetInformationJobObject(
                        self.handle,
                        JobObjectCpuRateControlInformation,
                        &mut cpu_info as *mut _ as *const _,
                        size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
                    )?;
                }
            }
        }

        Ok(())
    }

    pub fn assign_process(&self, process_handle: HANDLE) -> Result<()> {
        unsafe {
            AssignProcessToJobObject(self.handle, process_handle)?;
        }
        Ok(())
    }

    pub fn query_metrics(&self) -> Result<(u64, u64)> {
        let mut ext_info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let mut acct_info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };

        unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                &mut ext_info as *mut _ as *mut _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                None,
            )?;

            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                &mut acct_info as *mut _ as *mut _,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )?;
        }

        let peak_memory = ext_info.PeakJobMemoryUsed as u64;
        let total_cpu_time_100ns = (acct_info.TotalKernelTime + acct_info.TotalUserTime) as u64;
        let total_cpu_ms = total_cpu_time_100ns / 10_000;

        Ok((peak_memory, total_cpu_ms))
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}
