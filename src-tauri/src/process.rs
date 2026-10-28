use crate::error::{AppError, Result};
use std::{
    ffi::OsStr,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub struct Output {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
pub fn run(
    exe: &Path,
    cwd: &Path,
    args: &[&OsStr],
    input: Option<&[u8]>,
    timeout: Duration,
) -> Result<Output> {
    run_with_env(exe, cwd, args, input, timeout, &[])
}
pub fn run_with_env(
    exe: &Path,
    cwd: &Path,
    args: &[&OsStr],
    input: Option<&[u8]>,
    timeout: Duration,
    environment: &[(String, String)],
) -> Result<Output> {
    let mut c = Command::new(exe);
    c.current_dir(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, _) in std::env::vars_os() {
        if k.to_string_lossy().starts_with("GIT_") {
            c.env_remove(k);
        }
    }
    c.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat");
    for (key, value) in environment {
        c.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    #[cfg(windows)]
    let job = crate::job::Job::new()?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        c.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    }
    let mut child = c.spawn()?;
    #[cfg(windows)]
    let _job = {
        use std::os::windows::io::AsRawHandle;
        if let Err(error) = job.assign_and_resume(child.as_raw_handle(), child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        job
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new("internal", "Missing output pipe"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::new("internal", "Missing error pipe"))?;
    fn drain(mut r: impl Read) -> std::io::Result<(Vec<u8>, bool)> {
        let mut out = Vec::new();
        let mut overflow = false;
        let mut b = [0; 16384];
        loop {
            let n = r.read(&mut b)?;
            if n == 0 {
                break;
            }
            if out.len() + n <= 16 * 1024 * 1024 {
                out.extend_from_slice(&b[..n]);
            } else {
                overflow = true;
            }
        }
        Ok((out, overflow))
    }
    let a = thread::spawn(move || drain(stdout));
    let b = thread::spawn(move || drain(stderr));
    let data = input.map(Vec::from).unwrap_or_default();
    let stdin = child.stdin.take();
    let writer = thread::spawn(move || {
        if let Some(mut stdin) = stdin {
            stdin.write_all(&data)
        } else {
            Ok(())
        }
    });
    let start = Instant::now();
    let mut status = None;
    let status = loop {
        if status.is_none() {
            status = child.try_wait()?;
        }
        if let Some(status) = status {
            if writer.is_finished() && a.is_finished() && b.is_finished() {
                break status;
            }
        }
        if start.elapsed() > timeout {
            terminate_owned(&mut child)?;
            return Err(AppError::new(
                "unknownOutcome",
                "Operation timed out; inspect state before retrying",
            ));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let _ = writer
        .join()
        .map_err(|_| AppError::new("internal", "Input worker failed"))?;
    let (stdout, x) = a
        .join()
        .map_err(|_| AppError::new("internal", "Output worker failed"))??;
    let (stderr, y) = b
        .join()
        .map_err(|_| AppError::new("internal", "Error worker failed"))??;
    if x || y {
        return Err(AppError::limit());
    }
    Ok(Output {
        success: status.success(),
        exit_code: status.code(),
        stdout,
        stderr,
    })
}
pub fn terminate_owned(child: &mut std::process::Child) -> Result<()> {
    #[cfg(unix)]
    {
        // SAFETY: only a child created with process_group(0); its PID is our owned group ID.
        let r = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        if r != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(unix))]
    {
        child.kill()?;
    }
    child.wait()?;
    Ok(())
}
