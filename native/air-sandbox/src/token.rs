use windows::core::Result;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, TOKEN_DUPLICATE, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub struct RestrictedToken {
    handle: HANDLE,
}

impl RestrictedToken {
    pub fn create() -> Result<Self> {
        let mut current_token = HANDLE::default();
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_DUPLICATE | TOKEN_QUERY,
                &mut current_token,
            )?;
        }

        let mut restricted_token = HANDLE::default();
        let res = unsafe {
            CreateRestrictedToken(
                current_token,
                DISABLE_MAX_PRIVILEGE,
                Some(&[]),
                Some(&[]),
                Some(&[]),
                &mut restricted_token,
            )
        };

        unsafe {
            let _ = CloseHandle(current_token);
        }

        res?;

        Ok(Self {
            handle: restricted_token,
        })
    }

    #[allow(dead_code)]
    pub fn handle(&self) -> HANDLE {
        self.handle
    }
}

impl Drop for RestrictedToken {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}
