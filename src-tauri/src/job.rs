//! Owned Windows job handles. Assignment failure is fatal: never silently leave
//! a shell or Git subtree outside the termination boundary.
#![cfg(windows)]
use crate::error::{AppError, Result};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use windows_sys::Win32::{
    Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
        Threading::{
            GetProcessIdOfThread, OpenThread, ResumeThread, THREAD_QUERY_LIMITED_INFORMATION,
            THREAD_SUSPEND_RESUME,
        },
    },
};
pub struct Job(OwnedHandle);
impl Job {
    pub fn new() -> Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) });
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(job)
    }
    fn handle(&self) -> HANDLE {
        self.0.as_raw_handle() as HANDLE
    }
    pub fn assign(&self, process: RawHandle) -> Result<()> {
        if unsafe { AssignProcessToJobObject(self.handle(), process as HANDLE) } == 0 {
            return Err(AppError::new(
                "processOwnership",
                "Unable to assign the process to an owned Windows job; launch was stopped",
            ));
        }
        Ok(())
    }
    /// Caller creates the process with CREATE_SUSPENDED. Assign the entire
    /// process before resuming its sole primary thread; no program can spawn
    /// a descendant in the former launch/assignment gap.
    pub fn assign_and_resume(&self, process: RawHandle, pid: u32) -> Result<()> {
        self.assign(process)?;
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().into());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot as RawHandle) };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut ids = Vec::new();
        let mut present = unsafe { Thread32First(snapshot.as_raw_handle() as HANDLE, &mut entry) };
        while present != 0 {
            if entry.dwSize as usize >= std::mem::offset_of!(THREADENTRY32, th32OwnerProcessID) + 4
                && entry.th32OwnerProcessID == pid
            {
                ids.push(entry.th32ThreadID);
            }
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            present = unsafe { Thread32Next(snapshot.as_raw_handle() as HANDLE, &mut entry) };
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
            return Err(error.into());
        }
        if ids.len() != 1 {
            return Err(AppError::new(
                "processOwnership",
                "Suspended process primary thread could not be identified; launch stopped",
            ));
        }
        let thread = unsafe {
            OpenThread(
                THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                0,
                ids[0],
            )
        };
        if thread.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let thread = unsafe { OwnedHandle::from_raw_handle(thread as RawHandle) };
        if unsafe { GetProcessIdOfThread(thread.as_raw_handle() as HANDLE) } != pid {
            return Err(AppError::new(
                "processOwnership",
                "Suspended thread identity changed; launch stopped",
            ));
        }
        if unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) } != 1 {
            return Err(AppError::new(
                "processOwnership",
                "Suspended process could not be resumed safely; launch stopped",
            ));
        }
        Ok(())
    }
    pub fn terminate(&self) -> Result<()> {
        if unsafe { TerminateJobObject(self.handle(), 1) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::windows::process::CommandExt,
        process::Command,
        time::{Duration, Instant},
    };
    #[test]
    fn suspended_child_cannot_run_before_job_assignment() {
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("started.txt");
        let job = Job::new().unwrap();
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "echo owned>started.txt"])
            .current_dir(temp.path())
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(!marker.exists(), "Suspended command ran before containment");
        job.assign_and_resume(child.as_raw_handle(), child.id())
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() > deadline {
                job.terminate().unwrap();
                let _ = child.wait();
                panic!("Contained child did not finish");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(marker.exists());
    }
}
